# OpenBCI WiFi Shield -> COM bridge for BioEra

This Node.js script streams OpenBCI Cyton + WiFi Shield data into a Windows COM port (via a virtual COM pair). BioEra can then read the signal from COM like a normal serial OpenBCI device (with a minimal latency).

Why: BioEra expects COM/serial input, but WiFi Shield streams over TCP. This bridge lets you use WiFi setups (including cheap Chinese Cyton/WiFi clones) with BioEra without LSL. It works with BrainBay too.

How to use:

Create a com0com pair (example COM6<->COM7).

Script opens one end (example COM7). BioEra opens the other end (example COM6) in the SerialPort component or as usual OpenBCI device.

Put settings in .env (shield IP, local IP, COM port, init command).

Run: npm start

Press Play in BioEra.
