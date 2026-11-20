# HootBox firmware

USB controller for OWL IN: a push rotary encoder (KY-040) and two buttons on an ELEGOO / Arduino MEGA2560 R3.
It sends protocol v1 over USB serial, and the player site reads it with Web Serial (Chrome or Edge, at
`http://localhost:5173` on the computer the board is plugged into).

## Parts

- ELEGOO MEGA2560 R3 (or any Arduino Mega 2560) and a USB-B cable
- KY-040 push rotary encoder module (pins CLK, DT, SW, +, GND)
- 2 momentary push buttons (**A** = yes / call / hit, **B** = no / back / stand, hold B = fold / leave)
- Jumper wires (and a breadboard for the buttons)

## Wiring

No resistors needed: every input uses the Mega's internal pull-up, and every switch connects its pin to GND
(pressed = LOW). Wire it with the USB cable unplugged.

| Part | Pin | Mega pin |
|---|---|---|
| Encoder | CLK | **D2** (interrupt) |
| Encoder | DT | **D3** (interrupt) |
| Encoder | SW (dial press) | **D4** |
| Encoder | + | 5V |
| Encoder | GND | GND |
| Button A | one leg / other leg | **D5** / GND |
| Button B | one leg / other leg | **D6** / GND |

On a 4-leg tactile button, use two **diagonally opposite** legs: legs on the same side are often always connected.

## Upload

1. Install **Arduino IDE 2** and plug in the board.
2. **Tools → Board → Arduino AVR Boards → Arduino Mega or Mega 2560**, and **Tools → Port →** the board's COM port.
   No port showing up? Some ELEGOO boards use a CH340 USB chip: install the CH340 driver and replug.
3. Open `hootbox.ino` and click **Upload**.

From a terminal (arduino-cli, also bundled with the IDE):

```sh
arduino-cli compile --fqbn arduino:avr:mega hardware/hootbox
arduino-cli upload  --fqbn arduino:avr:mega -p COM5 hardware/hootbox   # your port
```

## Test on its own

**Tools → Serial Monitor**, 115200 baud, line ending "Newline". You should see:

| Do | Prints |
|---|---|
| Reset / open the monitor | `HOOTBOX 1` |
| One click clockwise / counter-clockwise | `R+1` / `R-1` |
| Press / release the dial | `P1` / `P0` |
| Press / release A | `A1` / `A0` |
| Press / release B | `B1` / `B0` |

A fast spin may print `R+2`, `R+3`: that's several detents in one line, as intended.

**Close the Serial Monitor before connecting the browser.** Only one program can hold a COM port.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Clockwise prints `R-1` | Set `#define OWL_REVERSE 1` at the top of the sketch (don't change the browser) |
| Only every other click counts | Your encoder has 2 transitions per detent: set `#define OWL_HALF_STEP 1` |
| A button prints nothing | Check it's wired between its pin and GND, using diagonal legs |
| A button prints `1` at boot and never `0` | Same-side legs (always connected): move one wire to the diagonal leg |
| Nothing at all | Wrong baud rate (must be 115200) or wrong port |

## Protocol v1

115200 baud, ASCII, one event per line ending in `\n`. The browser ignores any other line, and tolerates a `\r`
before the `\n`. The firmware has no hold timing: the browser times holds and fast turns.

| Line | Meaning |
|---|---|
| `HOOTBOX 1` | Hello (sent on boot; `1` = protocol version) |
| `R+n` / `R-n` | `n` detents clockwise / counter-clockwise (1–999) |
| `P1` / `P0` | Dial pressed / released |
| `A1` / `A0` | Button A pressed / released |
| `B1` / `B0` | Button B pressed / released |

Opening the port from the browser resets the Mega (DTR), so the hello arrives about 1.5 s after connecting.

## How it works

- **Encoder:** interrupts on both CLK and DT (CHANGE) run a quadrature state table. Valid transitions count ±1 and
  invalid ones (a missed edge) count 0. A detent is counted only when the encoder reaches its rest position, and the
  sub-count resets there, so bounce can't make the count drift. The interrupt only counts; `loop()` prints.
- **Buttons:** polled in `loop()` with a 20 ms `millis()` debounce, reporting both press and release.
- `loop()` never blocks (no `delay()`).
