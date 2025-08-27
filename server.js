// server.js
const express = require('express');
const ftp = require('basic-ftp');
const multer = require('multer');
const stream = require('stream');
const path = require('path');

const app = express();
const port = 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname))); // Serve static files like index.html

// Use multer for memory storage of uploaded files
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// --- FTP Client Helper ---
async function getFtpClient(config) {
    const client = new ftp.Client();
    // client.ftp.verbose = true; // Uncomment for detailed FTP logging
    try {
        await client.access({
            host: config.host,
            port: config.port,
            user: config.user,
            password: config.password,
            secure: true, // Enforce FTPS (FTP over SSL/TLS)
            secureOptions: {
                rejectUnauthorized: false // Often needed for self-signed certificates on FTP servers
            }
        });
    } catch (err) {
        console.error("FTP Connection Error:", err);
        throw new Error("Failed to connect to FTP server. Check credentials and ensure FTPS (secure FTP) is enabled.");
    }
    return client;
}

// --- API Endpoints ---

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Endpoint to test FTP connection
app.post('/api/test-connection', async (req, res) => {
    const config = req.body;
    let client;
    try {
        client = await getFtpClient(config);
        // Ensure the base directory exists
        await client.ensureDir("/certificates/images");
        res.status(200).json({ message: 'Connection successful.' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    } finally {
        if (client) client.close();
    }
});

// Endpoint to get all certificates
app.post('/api/certificates', async (req, res) => {
    const config = req.body;
    let client;
    try {
        client = await getFtpClient(config);
        
        // Check if manifest exists, if not, return empty array
        const files = await client.list('/certificates');
        if (!files.some(file => file.name === 'manifest.json')) {
            return res.status(200).json([]);
        }

        const readable = new stream.PassThrough();
        await client.downloadTo(readable, "/certificates/manifest.json");

        let data = '';
        for await (const chunk of readable) {
            data += chunk.toString();
        }
        res.status(200).json(JSON.parse(data));
    } catch (error) {
        // If manifest doesn't exist or is empty, it's not a server error, just no data.
        if (error.code === 550) { 
             return res.status(200).json([]);
        }
        res.status(500).json({ message: error.message });
    } finally {
        if (client) client.close();
    }
});

// Endpoint to upload a new certificate
app.post('/api/upload', upload.single('image'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ message: 'No image file uploaded.' });
    }

    const { certNumber, issueDate, issuedToName } = req.body;
    const ftpConfig = JSON.parse(req.body.ftpConfig);
    let client;

    try {
        client = await getFtpClient(ftpConfig);

        // 1. Download current manifest
        let manifest = [];
        try {
            const readable = new stream.PassThrough();
            await client.downloadTo(readable, "/certificates/manifest.json");
            let data = '';
            for await (const chunk of readable) { data += chunk.toString(); }
            manifest = JSON.parse(data);
        } catch (error) {
            if (error.code !== 550) throw error; // Ignore "file not found", handle others
            console.log('Manifest not found, creating a new one.');
        }

        // 2. Upload image file
        const imagePath = `/certificates/images/${certNumber}.jpg`;
        const readableImage = stream.Readable.from(req.file.buffer);
        await client.uploadFrom(readableImage, imagePath);
        
        // 3. Update manifest
        const imageUrl = `/api/image/${certNumber}.jpg`; // Use a proxy URL
        const newCert = { certNumber, issueDate, issuedToName, imageUrl };

        // Remove existing entry if it exists, then add the new one
        manifest = manifest.filter(c => c.certNumber !== certNumber);
        manifest.unshift(newCert);

        // 4. Upload new manifest
        const readableManifest = stream.Readable.from(JSON.stringify(manifest, null, 2));
        await client.uploadFrom(readableManifest, "/certificates/manifest.json");

        res.status(201).json({ message: 'Certificate uploaded successfully.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: error.message });
    } finally {
        if (client) client.close();
    }
});


// Endpoint to delete a certificate
app.post('/api/delete', async (req, res) => {
    const { certNumber, ...ftpConfig } = req.body;
    let client;
    try {
        client = await getFtpClient(ftpConfig);

        // 1. Download manifest
        let manifest = [];
        try {
            const readable = new stream.PassThrough();
            await client.downloadTo(readable, "/certificates/manifest.json");
            let data = '';
            for await (const chunk of readable) { data += chunk.toString(); }
            manifest = JSON.parse(data);
        } catch (error) {
            if (error.code === 550) throw new Error("Manifest file not found. Cannot delete.");
            throw error;
        }

        // 2. Remove certificate from manifest
        const updatedManifest = manifest.filter(c => c.certNumber !== certNumber);
        if (manifest.length === updatedManifest.length) {
            throw new Error("Certificate not found in manifest.");
        }

        // 3. Upload new manifest
        const readableManifest = stream.Readable.from(JSON.stringify(updatedManifest, null, 2));
        await client.uploadFrom(readableManifest, "/certificates/manifest.json");

        // 4. Delete image file
        await client.remove(`/certificates/images/${certNumber}.jpg`);

        res.status(200).json({ message: 'Certificate deleted successfully.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: error.message });
    } finally {
        if (client) client.close();
    }
});

// Proxy endpoint to serve images
app.get('/api/image/:certNumberJpg', (req, res) => {
    // This is a placeholder. For a real production app, you would need to implement
    // a way to get FTP credentials here, perhaps from a secure session,
    // to fetch the image from the FTP server and stream it to the user.
    // For now, this will not work directly and images will show as broken
    // in the admin panel until a more secure credential management is implemented.
    // A simpler approach is to make the FTP image folder publicly accessible via HTTP.
    res.status(404).send('Image proxy not fully implemented. For images to show, make your FTP folder accessible via HTTP.');
});


app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
});