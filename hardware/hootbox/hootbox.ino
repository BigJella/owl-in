/*
 * HootBox firmware: OWL IN's hardware controller (ELEGOO / Arduino MEGA2560 R3).
 *
 * A KY-040 push rotary encoder plus two buttons (A, B), reported over USB serial with
 * protocol v1 (see "HootBox" in the repo's CLAUDE.md). 115200 baud, ASCII, one event per line:
 *
 *   HOOTBOX 1     hello, once at boot (1 = protocol version)
 *   R+1 / R-1      one detent clockwise / counter-clockwise (R+3 = three detents at once)
 *   P1 / P0        dial pressed / released
 *   A1 / A0        button A pressed / released
 *   B1 / B0        button B pressed / released
 *
 * The browser does all timing (holds, fast turns), so this sketch only reports edges.
 * Wiring: every input is INPUT_PULLUP and every switch goes to GND, so pressed = LOW.
 */

// ---- Pins -------------------------------------------------------------------------------------
const uint8_t PIN_CLK = 2;  // encoder CLK (interrupt)
const uint8_t PIN_DT = 3;   // encoder DT  (interrupt)
const uint8_t PIN_SW = 4;   // encoder push switch
const uint8_t PIN_A = 5;    // button A
const uint8_t PIN_B = 6;    // button B

// ---- Settings ---------------------------------------------------------------------------------
// Clockwise prints R-1? Set this to 1 (it swaps the CLK/DT roles).
#define OWL_REVERSE 1
// Most KY-040s rest only at CLK=DT=HIGH (4 transitions per detent). If yours counts only every
// other click, it also rests at LOW/LOW (2 transitions per detent): set this to 1.
#define OWL_HALF_STEP 0

const unsigned long DEBOUNCE_MS = 20;

// ---- Encoder (interrupt-driven quadrature state table) -----------------------------------------
// Index = (previous state << 2) | current state, where state = (CLK << 1) | DT.
// Clockwise on a KY-040 goes 11 -> 01 -> 00 -> 10 -> 11 (CLK falls first).
// Invalid transitions (both pins changed at once, i.e. a missed edge) count 0.
const int8_t QUAD_TABLE[16] = {
   0, -1, +1,  0,
  +1,  0,  0, -1,
  -1,  0,  0, +1,
   0, +1, -1,  0,
};

volatile uint8_t encState = 0;       // last (CLK << 1) | DT
volatile int8_t encSub = 0;          // transitions since the last rest position
volatile int16_t encPending = 0;     // whole detents not yet printed

static inline uint8_t readEncoder() {
  return (uint8_t)((digitalRead(PIN_CLK) << 1) | digitalRead(PIN_DT));
}

// Runs on every CLK or DT edge. Only counts; never touches Serial.
void onEncoderEdge() {
  uint8_t now = readEncoder();
  uint8_t prev = encState;
  if (now == prev) return;
  encState = now;
  encSub += QUAD_TABLE[(prev << 2) | now];

  // A detent ends at a rest position. Count it there, then resync, so contact bounce and a
  // single missed edge can never leave the count drifting by a fraction of a detent.
  bool atRest = (now == 0b11) || (OWL_HALF_STEP && now == 0b00);
  if (!atRest) return;
  const int8_t need = OWL_HALF_STEP ? 2 : 3;  // full: 4 transitions, one may be missed
  if (encSub >= need) encPending++;
  else if (encSub <= -need) encPending--;
  encSub = 0;
}

// ---- Buttons (polled, 20 ms debounce) ----------------------------------------------------------
struct Button {
  uint8_t pin;
  char code;            // 'P', 'A' or 'B'
  bool stableDown;      // debounced state
  bool rawDown;         // last raw reading
  unsigned long changedAt;
};

Button buttons[] = {
  { PIN_SW, 'P', false, false, 0 },
  { PIN_A,  'A', false, false, 0 },
  { PIN_B,  'B', false, false, 0 },
};
const uint8_t BUTTON_COUNT = sizeof(buttons) / sizeof(buttons[0]);

// Takes an index, not a Button&: the IDE's generated prototypes would land above the struct.
void pollButton(uint8_t i, unsigned long now) {
  Button &b = buttons[i];
  bool down = digitalRead(b.pin) == LOW;
  if (down != b.rawDown) {
    b.rawDown = down;
    b.changedAt = now;
  } else if (down != b.stableDown && now - b.changedAt >= DEBOUNCE_MS) {
    b.stableDown = down;
    Serial.print(b.code);
    Serial.println(down ? '1' : '0');
  }
}

// ---- Main -------------------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);

  pinMode(PIN_CLK, INPUT_PULLUP);
  pinMode(PIN_DT, INPUT_PULLUP);
  for (uint8_t i = 0; i < BUTTON_COUNT; i++) {
    pinMode(buttons[i].pin, INPUT_PULLUP);
  }
  delay(5);  // let the pull-ups settle (setup only; loop() never blocks)

  // Start from the current levels so nothing is reported at boot.
  encState = readEncoder();
  unsigned long now = millis();
  for (uint8_t i = 0; i < BUTTON_COUNT; i++) {
    bool down = digitalRead(buttons[i].pin) == LOW;
    buttons[i].rawDown = buttons[i].stableDown = down;
    buttons[i].changedAt = now;
  }

  attachInterrupt(digitalPinToInterrupt(PIN_CLK), onEncoderEdge, CHANGE);
  attachInterrupt(digitalPinToInterrupt(PIN_DT), onEncoderEdge, CHANGE);

  Serial.println(F("HOOTBOX 1"));
}

void loop() {
  // Take the pending detents atomically, then print them outside the critical section.
  noInterrupts();
  int16_t steps = encPending;
  encPending = 0;
  interrupts();

  if (steps != 0) {
    if (OWL_REVERSE) steps = -steps;
    steps = constrain(steps, -999, 999);  // the browser accepts up to 3 digits
    Serial.print('R');
    if (steps > 0) Serial.print('+');
    Serial.println(steps);
  }

  unsigned long now = millis();
  for (uint8_t i = 0; i < BUTTON_COUNT; i++) {
    pollButton(i, now);
  }
}
