// Minimal Web Serial typings (Chrome / Edge), just what the HootBox uses.

interface SerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
}

interface SerialPort extends EventTarget {
  readonly readable: ReadableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  getInfo(): SerialPortInfo;
}

interface Serial extends EventTarget {
  getPorts(): Promise<SerialPort[]>;
  requestPort(options?: { filters?: SerialPortInfo[] }): Promise<SerialPort>;
}

interface Navigator {
  readonly serial?: Serial;
}
