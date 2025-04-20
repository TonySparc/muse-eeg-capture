const noble = require('@abandonware/noble');
const fs = require('fs');
const readline = require('readline');

// 1) UUIDs exactly as your demo
const MUSE_SERVICE = 'fe8d';
const CONTROL_UUID = '273e00014c4d454d96bef03bac821358';
const EEG_UUIDS = [
    '273e00034c4d454d96bef03bac821358',
    '273e00044c4d454d96bef03bac821358',
    '273e00054c4d454d96bef03bac821358',
    '273e00064c4d454d96bef03bac821358',
    '273e00074c4d454d96bef03bac821358',
];

// 2) State
let controlChar,
    eegChars = [];
let isRecording = false,
    isIntuitive = 0;
let dataBuffer = [],
    writeStream,
    filename;
let keepAliveTimer;

// 3) Framing: length byte + ASCII + '\n'
function encodeCommand(cmd) {
    const buf = Buffer.from('X' + cmd + '\n', 'ascii');
    buf[0] = buf.length - 1;
    return buf;
}

// ---- CRITICAL CHANGE: writeWithoutResponse = true ----
async function send(cmd) {
    if (!controlChar) return;
    await controlChar.writeAsync(encodeCommand(cmd), true);
    console.log(`>> Sent '${cmd}'`);
}

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// 4) README + Keybindings
fs.writeFileSync(
    'README.md',
    `# Kairos Muse Recorder

Controls:
- SPACE: mark intuitive
- R: start/stop 10s recording
- 1–9: send p1–p9
- S: send 's' (start stream)
- D: send 'd' (resume stream)
- H: send 'h' (halt stream)
- Ctrl+C: exit
`,
);

readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
process.stdin.on('keypress', (_, key) => {
    if (key.ctrl && key.name === 'c') process.exit();
    if (key.name === 'space') {
        isIntuitive = 1;
        console.log('>> Intuitive marked');
    } else if (key.name === 'r') {
        isRecording ? stopRecording() : startRecording();
    } else if (['s', 'd', 'h'].includes(key.name)) send(key.name);
    else if (key.name >= '1' && key.name <= '9') send(`p${key.name}`);
});

function startRecording() {
    isRecording = true;
    filename = `muse_data_${Date.now()}.csv`;
    writeStream = fs.createWriteStream(filename);
    writeStream.write('timestamp,electrode,s1,s2,s3,s4,s5,intuitive\n');
    console.log(`>> Recording → ${filename}`);
    setTimeout(stopRecording, 10000);
}

function stopRecording() {
    if (!isRecording) return;
    isRecording = false;
    writeStream.end();
    console.log(`>> Saved → ${filename}`);
}

// 5) BLE scan + connect
noble.on('stateChange', async (state) => {
    if (state === 'poweredOn') {
        console.log('Scanning for Muse…');
        await noble.startScanningAsync([], false);
    } else {
        await noble.stopScanningAsync();
    }
});

noble.on('discover', (peripheral) => {
    const name = peripheral.advertisement.localName || '';
    if (!name.toLowerCase().includes('muse')) return;

    noble.stopScanningAsync().then(async () => {
        console.log(`Connecting → ${name}…`);
        await peripheral.connectAsync();
        console.log(`Connected → ${name}`);

        peripheral.once('disconnect', () => process.exit());

        // 6) Discover service & characteristics via callbacks
        peripheral.discoverServices([MUSE_SERVICE], (err, services) => {
            if (err || services.length === 0) {
                console.error('Service discovery failed', err);
                return process.exit(1);
            }
            const svc = services[0];
            svc.discoverCharacteristics([CONTROL_UUID, ...EEG_UUIDS], async (err2, chars) => {
                if (err2 || !chars.length) {
                    console.error('Char discovery failed', err2);
                    return process.exit(1);
                }

                controlChar = chars.find((c) => c.uuid === CONTROL_UUID);
                EEG_UUIDS.forEach((u, i) => {
                    eegChars[i] = chars.find((c) => c.uuid === u);
                });

                // 7) Subscribe to EEG channels correctly
                for (let i = 0; i < eegChars.length; i++) {
                    const ch = eegChars[i];
                    if (!ch) continue;

                    await new Promise((resolve, reject) => {
                        ch.subscribe((error) => {
                            if (error) {
                                console.error(`Error subscribing EEG ${i}:`, error);
                                return reject(error);
                            }
                            console.log(`Subscribed EEG ${i}`);
                            resolve();
                        });
                    });

                    ch.on('data', (data) => {
                        dataBuffer.push(data);
                        if (isRecording) {
                            const t = Date.now();
                            const samples = [];
                            for (let off = 2; off < data.length && samples.length < 5; off += 2) {
                                samples.push(data.readInt16LE(off));
                            }
                            writeStream.write(`${t},${i},${samples.join(',')},${isIntuitive}\n`);
                        }
                    });
                }

                // 8) Initialize stream + keepalive
                await initStream(name);
            });
        });
    });
});

// 9) Full protocol init: h→v→i→preset→s→d + k every 9s
async function initStream(modelName) {
    await send('h');
    await delay(50);
    await send('v');
    await delay(50);
    await send('i');
    await delay(200);

    const preset = modelName.toLowerCase().includes('muses') ? 'p21' : 'p20';
    console.log(`Using preset ${preset}`);
    await send(preset);
    await delay(50);

    await send('s');
    await delay(50);
    await send('d');

    console.log('*** STREAMING ON ***');
    keepAliveTimer = setInterval(() => send('k'), 9000);

    setInterval(() => {
        console.log(`DEBUG: ${dataBuffer.length} packets`);
        dataBuffer = [];
    }, 2000);
}
