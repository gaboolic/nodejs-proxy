const WebSocket = require('ws');
const { Readable } = require('stream');
const net = require('net');

// 创建 WebSocket 服务器
const wss = new WebSocket.Server({ port: 443 });
let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = "64.68.192." + Math.floor(Math.random() * 255);

let address = '';
let portWithRandomLog = '';
const log = (/** @type {string} */ info, /** @type {string | undefined} */ event) => {
    console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
};

// 监听连接事件
wss.on('connection', (ws) => {
    console.log("ws connection")
    // 在每个连接上设置消息处理逻辑
    ws.once('message', (chunk) => {
        console.log("on message")
        let webSocket = ws;
        let remoteSocketWapper = {
            value: null,
        };
        let isDns = false;

        const {
            hasError,
            message,
            portRemote = 443,
            addressRemote = '',
            rawDataIndex,
            vlessVersion = new Uint8Array([0, 0]),
            isUDP,
        } = processVlessHeader(chunk, userID);

        address = addressRemote;
        portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? 'udp ' : 'tcp '
        } `;
        if (hasError) {
            // controller.error(message);
            // throw new Error(message); // cf seems has bug, controller.error will not end stream
            // webSocket.close(1000, message);
            console.log('hasError,Connection closed:'+message);
            ws.close();
            return;
        }
        // if UDP but port not DNS port, close it
        if (isUDP) {
            if (portRemote === 53) {
                isDns = true;
            } else {
                // controller.error('UDP proxy only enable for DNS which is port 53');
                throw new Error('UDP proxy only enable for DNS which is port 53'); // cf seems has bug, controller.error will not end stream
                return;
            }
        }
        // ["version", "附加信息长度 N"]
        const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
        const rawClientData = chunk.slice(rawDataIndex);

        if (isDns) {
            return handleDNSQuery(rawClientData, webSocket, vlessResponseHeader, log);
        }
        handleTCPOutBound(remoteSocketWapper, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log);
    });

    // 监听连接断开事件
    ws.on('close', () => {
        console.log('Connection closed');
        ws.close();
    });
});


/**
 * Handles outbound TCP connections.
 *
 * @param {any} remoteSocket
 * @param {string} addressRemote The remote address to connect to.
 * @param {number} portRemote The remote port to connect to.
 * @param {Uint8Array} rawClientData The raw client data to write.
 * @param {WebSocket} webSocket The WebSocket to pass the remote socket to.
 * @param {Uint8Array} vlessResponseHeader The VLESS response header.
 * @param {function} log The logging function.
 * @returns {Promise<void>} The remote socket.
 */
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log,) {
    async function connectAndWrite(address, port) {
        const options = {
            host: address, // 服务器主机地址
            port: port         // 服务器监听的端口号
        };

        const tcpSocket = net.createConnection(options, () => {
            console.log('已连接到服务器');
        });

        remoteSocket.value = tcpSocket;
        log(`handleTCPOutBound connected to ${address}:${port}`);
        // const writer = tcpSocket.writable.getWriter();
        console.log("rawClientData:"+rawClientData)
        tcpSocket.write(rawClientData); // first write, nomal is tls client hello
        // writer.releaseLock();
        return tcpSocket;
    }

    // if the cf connect tcp socket have no incoming data, we retry to redirect ip
    async function retry() {
        console.log("retry")
        const tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote)
        // no matter retry success or not, close websocket
        tcpSocket.closed.catch(error => {
            console.log('retry tcpSocket closed error', error);
        }).finally(() => {
            safeCloseWebSocket(webSocket);
        })
        remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null, log);
    }

    const tcpSocket = await connectAndWrite(addressRemote, portRemote);

    // when remoteSocket is ready, pass to websocket
    // remote--> ws
    remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry, log);
}

/**
 *
 * @param {net.Socket} remoteSocket
 * @param {WebSocket} webSocket
 * @param {ArrayBuffer} vlessResponseHeader
 * @param {(() => Promise<void>) | null} retry
 * @param {*} log
 */
async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry, log) {
    // remote--> ws
    let remoteChunkCount = 0;
    let chunks = [];
    /** @type {ArrayBuffer | null} */
    let vlessHeader = vlessResponseHeader;


    // 监听 'data' 事件，将数据推送到可读流中
    remoteSocket.on('data', (data) => {
        // console.log("接收到data:"+data)
        if (vlessHeader) {
            new Blob([vlessHeader, data]).arrayBuffer()
                .then(arrayBuffer => {
                    webSocket.send(arrayBuffer);
                })
                .catch(error => {
                    console.error('处理 ArrayBuffer 出错：', error);
                });

            vlessHeader = null;
        } else {
            webSocket.send(data);
        }
    });

    // 监听 'end' 事件，标记流的结束
    remoteSocket.on('end', () => {
        console.log("remoteSocket on end end end")
        webSocket.send(null);
    });
    let is_error = false;

    // 监听 'error' 事件
    remoteSocket.on('error', () => {
        is_error = true;
    });

    if (is_error && retry) {
        log(`retry`)
        retry();
    }
}


/**
 * https://xtls.github.io/development/protocols/vless.html
 * 1 字节        16 字节         1 字节            M 字节       1 字节    2 字节    1 字节    S 字节    X 字节
 * 协议版本    等价 UUID    附加信息长度 M    附加信息ProtoBuf    指令        端口      地址类型    地址    请求数据
 * @param { ArrayBuffer} vlessBuffer
 * @param {string} userID
 * @returns
 */
function processVlessHeader(
    vlessBuffer,
    userID
) {
    if (vlessBuffer.byteLength < 24) {
        return {
            hasError: true,
            message: 'invalid data',
        };
    }
    const version = new Uint8Array(vlessBuffer.slice(0, 1));
    let isValidUser = false;
    let isUDP = false;
    if (stringify(new Uint8Array(vlessBuffer.slice(1, 17))) === userID) {
        console.log(stringify(new Uint8Array(vlessBuffer.slice(1, 17))))
        console.log(userID)
        isValidUser = true;
    }
    if (!isValidUser) {
        console.log(stringify(new Uint8Array(vlessBuffer.slice(1, 17))))
        console.log(userID)
        return {
            hasError: true,
            message: 'invalid user',
        };
    }

    const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
    //skip opt for now

    const command = new Uint8Array(
        vlessBuffer.slice(18 + optLength, 18 + optLength + 1)
    )[0];

    // 0x01 TCP
    // 0x02 UDP
    // 0x03 MUX
    if (command === 1) {
    } else if (command === 2) {
        isUDP = true;
    } else {
        return {
            hasError: true,
            message: `command ${command} is not support, command 01-tcp,02-udp,03-mux`,
        };
    }
    const portIndex = 18 + optLength + 1;
    const portBuffer = vlessBuffer.slice(portIndex, portIndex + 2);
    // port is big-Endian in raw data etc 80 == 0x005d
    const portRemote = portBuffer.readUInt16BE();

    let addressIndex = portIndex + 2;
    const addressBuffer = new Uint8Array(
        vlessBuffer.slice(addressIndex, addressIndex + 1)
    );

    // 1--> ipv4  addressLength =4
    // 2--> domain name addressLength=addressBuffer[1]
    // 3--> ipv6  addressLength =16
    const addressType = addressBuffer[0];
    let addressLength = 0;
    let addressValueIndex = addressIndex + 1;
    let addressValue = '';
    switch (addressType) {
        case 1:
            addressLength = 4;
            addressValue = new Uint8Array(
                vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
            ).join('.');
            break;
        case 2:
            addressLength = new Uint8Array(
                vlessBuffer.slice(addressValueIndex, addressValueIndex + 1)
            )[0];
            addressValueIndex += 1;
            addressValue = new TextDecoder().decode(
                vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
            );
            break;
        case 3:
            addressLength = 16;
            const dataView = new DataView(
                vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
            );
            // 2001:0db8:85a3:0000:0000:8a2e:0370:7334
            const ipv6 = [];
            for (let i = 0; i < 8; i++) {
                ipv6.push(dataView.getUint16(i * 2).toString(16));
            }
            addressValue = ipv6.join(':');
            // seems no need add [] for ipv6
            break;
        default:
            return {
                hasError: true,
                message: `invild  addressType is ${addressType}`,
            };
    }
    if (!addressValue) {
        return {
            hasError: true,
            message: `addressValue is empty, addressType is ${addressType}`,
        };
    }

    return {
        hasError: false,
        addressRemote: addressValue,
        addressType,
        portRemote,
        rawDataIndex: addressValueIndex + addressLength,
        vlessVersion: version,
        isUDP,
    };
}

const byteToHex = [];
for (let i = 0; i < 256; ++i) {
    byteToHex.push((i + 256).toString(16).slice(1));
}

function unsafeStringify(arr, offset = 0) {
    return (byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]).toLowerCase();
}
function stringify(arr, offset = 0) {
    const uuid = unsafeStringify(arr, offset);
    return uuid;
}

/**
 *
 * @param {ArrayBuffer} udpChunk
 * @param {WebSocket} webSocket
 * @param {Uint8Array} vlessResponseHeader
 * @param {(string)=> void} log
 */
async function handleDNSQuery(udpChunk, webSocket, vlessResponseHeader, log) {
    // no matter which DNS server client send, we alwasy use hard code one.
    // beacsue someof DNS server is not support DNS over TCP
    try {
        const dnsServer = '8.8.4.4'; // change to 1.1.1.1 after cf fix connect own ip bug
        const dnsPort = 53;
        /** @type {ArrayBuffer | null} */
        let vlessHeader = vlessResponseHeader;

        const options = {
            host: dnsServer, // 服务器主机地址
            port: dnsPort         // 服务器监听的端口号
        };
        const tcpSocket = net.createConnection(options, () => {
            console.log('handleDNSQuery 已连接到服务器');
        });

        log(`connected to ${dnsServer}:${dnsPort}`);
        tcpSocket.write(udpChunk)

        // 监听 'data' 事件，将数据推送到可读流中
        tcpSocket.on('data', (data) => {
            if (webSocket.readyState === WS_READY_STATE_OPEN) {
                if (vlessHeader) {
                    new Blob([vlessHeader, data]).arrayBuffer()
                        .then(arrayBuffer => {
                            webSocket.send(arrayBuffer);
                        })
                        .catch(error => {
                            console.error('处理 ArrayBuffer 出错：', error);
                        });
                    vlessHeader = null;
                } else {
                    webSocket.send(data);
                }
            }
        });
    } catch (error) {
        console.error(
            `handleDNSQuery have exception, error: ${error.message}`
        );
    }
}
/**
 * Normally, WebSocket will not has exceptions when close.
 * @param {import("@cloudflare/workers-types").WebSocket} socket
 */
function safeCloseWebSocket(socket) {
    try {
        if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
            socket.close();
        }
    } catch (error) {
        console.error('safeCloseWebSocket error', error);
    }
}