# Universal RF Remote for Homey Pro

Send 433 MHz codes captured with a [Flipper Zero](https://flipperzero.one) from your Homey Pro. Create a remote control device, add as many buttons as you like with your own labels, and give each button a code – either by loading the `.sub` file the Flipper saved, or by typing in the protocol, key, bit count, TE and frequency exactly as the Flipper shows them.

## Features

- **Remote control device** with a chosen name, icon and device type, and up to 16 labelled buttons.
- **Codes from Flipper Zero `.sub` files** (Key, RAW and BinRAW) or entered by hand, each with a *Test* button during pairing.
- **32 fixed-code protocols** rebuilt from the decoded values the same way the Flipper does: Princeton, CAME, Nice FLO, Holtek, Holtek_HT12X, Linear, LinearDelta3, GateTX, Cham_Code, MegaCode, Ansonic, SMC5326, Phoenix_V2, Power Smart, BETT, Doitrand, Intertechno_V3, Clemsa, Dooya, Hormann HSM, Marantec, Marantec24, Mastercode, Legrand, Dickert_MAHS, Magellan, Feron, Nero Radio, Nero Sketch, Honeywell, Elplast and Roger.
- **Flow cards:** *Press a button*, *A button is pressed* and *Send a 433 MHz code*.
- **Repair device** to add, remove, relabel and reorder buttons or change codes.
- English and Danish.

## Where to get codes

- **Read your own remote** with a Flipper Zero (*Sub-GHz → Read*) and save it – this gives the `.sub` file.
- **Download ready-made `.sub` files** from community collections, for example [UberGuidoZ/Flipper – Sub-GHz](https://github.com/UberGuidoZ/Flipper/tree/main/Sub-GHz), which has thousands of files sorted by device type and brand. Open the file on GitHub, copy its contents and paste them into the button on the pairing page.
- **Type the values in** (protocol, key, bits, TE, frequency) if you know them, e.g. from a label or a manual.

Codes from a download only work if your receiver was paired with exactly that code. For fixed-code devices that learn the code from a remote (many sockets, doorbells and awning motors), you can usually pair the receiver with a downloaded or invented code: put the receiver in learning mode and press *Test* on the pairing page.

## Limitations

- Homey Pro (Early 2023) transmits on **433.00–433.99 MHz** with AM/OOK only. 868 MHz and FM/FSK recordings are not supported.
- **Rolling-code remotes** (KeeLoq, Somfy RTS, Nice FloR-S, CAME Atomo, Security+ …) cannot be replayed. The app refuses them with an explanation.
- A frame can hold at most 256 pulses (a Homey radio limit). Long RAW recordings are reduced to one clean repetition automatically.

## How it works

Homey apps cannot send raw pulse lists: every transmission must use a signal defined in `app.json`, where a signal is a set of `[high, low]` "words" in µs and a frame is a list of word indexes. `scripts/build.js` therefore generates a catalogue of ~312 signals:

- `p_<protocol>_<kHz>` – the exact pulse pairs for each fixed-timing protocol,
- `te<TE>_<kHz>` – protocols whose timing comes from the file (Princeton and friends) in 10/25 µs steps,
- `grid_<kHz>` – a generic 24×32 log-spaced table used for RAW recordings and as a fallback,

for the carriers 433.92, 433.42 and 433.07 MHz. At runtime `lib/radio.js` encodes the code to pulses (`lib/protocols.js`), picks the best signal and maps the pulses to word indexes.

## Development

```sh
npm test                    # self-test of the pure logic in lib/
node scripts/build.js       # regenerate signals in app.json and copy views/remote.html to the driver
homey app validate --level publish
homey app install
```

Edit the pairing page in `views/remote.html` – the copies in `drivers/remote/pair` and `repair` are overwritten by the build script.

## Credits and license

The protocol encoders are ported from the Sub-GHz implementation in the [Flipper Zero firmware](https://github.com/flipperdevices/flipperzero-firmware) by Flipper Devices Inc. (GPL-3.0). Universal RF Remote is an independent app and is not affiliated with Flipper Devices.

Licensed under the GNU General Public License v3.0 – see [LICENSE](LICENSE).

Bug reports and suggestions: [GitHub issues](https://github.com/bosund/universal-rf-remote/issues).
