// server.js
const express = require('express');
const ftp = require('basic-ftp');
const multer = require('multer');
const stream = require('stream');
const path = require('path');
const { PassThrough } = require('stream');

const app = express();
const port = 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname))); // Serve static files

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const CERT_BASE_PATH = "/certificates";
const MANIFEST_PATH = `${CERT_BASE_PATH}/manifest.json`;
const IMAGES_PATH = `${CERT_BASE_PATH}/images`;

// --- FTP Client Helper ---
async function getFtpClient(config) {
    const client = new ftp.Client(30000); // 30 second timeout
    // client.ftp.verbose = true; // Uncomment for detailed FTP debugging
    try {
        const accessOptions = {
            host: config.host,
            port: config.port,
            user: config.user,
            password: config.password,
            // Use secure settings from client
            secure: config.secure === 'implicit' ? 'implicit' : false,
        };
        
        // The 'secure' option in basic-ftp can be true/false/'implicit'
        // 'implicit' is for FTPS on port 990. Standard FTPS uses explicit on port 21.
        // For simplicity, we'll let the user choose.
        if (config.secure === 'implicit') {
            accessOptions.secure = 'implicit';
        } else {
            accessOptions.secure = false; // Plain FTP
        }

        await client.access(accessOptions);
    } catch (err) {
        console.error("FTP Connection Error:", err.message);
        throw new Error(`FTP connection failed: ${err.message}. Check host, credentials, and security setting.`);
    }
    return client;
}

// Helper to fetch the manifest file
async function getManifest(client) {
    try {
        const readable = new stream.PassThrough();
        await client.downloadTo(readable, MANIFEST_PATH);
        let data = '';
        for await (const chunk of readable) {
            data += chunk.toString('utf8');
        }
        return JSON.parse(data);
    } catch (error) {
        // If file not found (550), it's not an error, just means we need to create it.
        if (error.code === 550) {
            console.log("Manifest not found, will create a new one.");
            return [];
        }
        // For other errors, re-throw them.
        throw error;
    }
}


// --- API Endpoints ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/test-connection', async (req, res) => {
    let client;
    try {
        client = await getFtpClient(req.body);
        await client.ensureDir(IMAGES_PATH); // Ensure base directories exist
        res.status(200).json({ message: 'Connection successful. Certificate directory is ready.' });
    } catch (error) {
        console.error("[Test Connection Error]:", error);
        res.status(500).json({ message: error.message });
    } finally {
        if (client) client.close();
    }
});

app.post('/api/certificates', async (req, res) => {
    let client;
    try {
        client = await getFtpClient(req.body);
        const manifest = await getManifest(client);
        res.status(200).json(manifest);
    } catch (error) {
        console.error("[Get Certificates Error]:", error);
        res.status(500).json({ message: error.message });
    } finally {
        if (client) client.close();
    }
});

// A public endpoint to get all certs for verification without credentials
app.get('/api/get-all-certs', async (req, res) => {
    // SECURITY WARNING: This endpoint assumes the manifest.json is on a publicly readable
    // FTP server or that you will implement a secure way to store credentials on the server.
    // For this example, we'll assume it's okay, but in production, you MUST secure this.
    // A better approach would be to cache the manifest on the Node.js server itself.
    
    // This is a simplified example. You would need to store FTP creds securely on the server.
    // For now, it will fail unless you hardcode credentials here, which is NOT recommended.
    // The verification on the main page will rely on the admin loading the data first.
    res.status(501).json({ message: "Public verification endpoint not implemented. Verify after connecting as admin." });
});


app.post('/api/upload', upload.single('image'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ message: 'No image file uploaded.' });
    }
    const { certNumber, issueDate, issuedToName } = req.body;
    const ftpConfig = JSON.parse(req.body.ftpConfig);
    let client;
    try {
        client = await getFtpClient(ftpConfig);
        const manifest = await getManifest(client);

        const imageExtension = path.extname(req.file.originalname) || '.jpg';
        const imagePath = `${IMAGES_PATH}/${certNumber}${imageExtension}`;
        await client.uploadFrom(stream.Readable.from(req.file.buffer), imagePath);

        const imageUrl = `/api/image/${certNumber}${imageExtension}`;
        const newCert = { certNumber, issueDate, issuedToName, imageUrl };

        const updatedManifest = manifest.filter(c => c.certNumber !== certNumber);
        updatedManifest.unshift(newCert);

        await client.uploadFrom(stream.Readable.from(JSON.stringify(updatedManifest, null, 2)), MANIFEST_PATH);
        res.status(201).json({ message: 'Certificate uploaded successfully.' });
    } catch (error) {
        console.error("[Upload Error]:", error);
        res.status(500).json({ message: error.message });
    } finally {
        if (client) client.close();
    }
});

app.post('/api/delete', async (req, res) => {
    const { certNumber, ...ftpConfig } = req.body;
    let client;
    try {
        client = await getFtpClient(ftpConfig);
        const manifest = await getManifest(client);
        const certToDelete = manifest.find(c => c.certNumber === certNumber);

        const updatedManifest = manifest.filter(c => c.certNumber !== certNumber);
        if (manifest.length === updatedManifest.length) {
            return res.status(404).json({ message: "Certificate not found in manifest." });
        }
        
        await client.uploadFrom(stream.Readable.from(JSON.stringify(updatedManifest, null, 2)), MANIFEST_PATH);
        
        if (certToDelete) {
            const imageName = path.basename(certToDelete.imageUrl);
            await client.remove(`${IMAGES_PATH}/${imageName}`);
        }

        res.status(200).json({ message: 'Certificate deleted successfully.' });
    } catch (error) {
        console.error("[Delete Error]:", error);
        res.status(500).json({ message: error.message });
    } finally {
        if (client) client.close();
    }
});

app.get('/api/image/:imageName', async (req, res) => {
    // This endpoint is tricky because it's stateless; it doesn't know the FTP credentials.
    // For a real app, you would need a session or token to authenticate this request.
    // As a workaround, we'll tell the browser that the resource is unavailable.
    // To make this work, your FTP images folder would need to be publicly accessible via HTTP.
    res.status(404).send('Image preview requires the FTP images directory to be publicly accessible via a web URL.');
});

app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
});