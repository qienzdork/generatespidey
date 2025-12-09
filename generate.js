require('dotenv').config();
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const traits = require('./traits');

// Configuration
const TOTAL_SUPPLY = 10000;
const IMAGE_DIR = path.join(__dirname, 'images');
const METADATA_DIR = path.join(__dirname, 'metadata');
const DELAY_MS = 500; // Delay between generations to avoid rate limits

// Filebase S3 Client
const s3 = new S3Client({
    endpoint: 'https://s3.filebase.com',
    region: 'us-east-1',
    credentials: {
        accessKeyId: process.env.FILEBASE_KEY,
        secretAccessKey: process.env.FILEBASE_SECRET,
    },
});

const BUCKET_NAME = process.env.FILEBASE_BUCKET;

// State
let allMetadata = [];
let rarityCounts = {
    backgrounds: {},
    accessories: {},
    poses: {},
    colors: {}
};

// Initialize Rarity Counts
Object.keys(traits).forEach(category => {
    traits[category].forEach(trait => {
        rarityCounts[category][trait] = 0;
    });
});

// Helper: Random Trait Selection
function getRandomTrait(category) {
    const options = traits[category];
    return options[Math.floor(Math.random() * options.length)];
}

// Helper: Sleep
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: Upload to Filebase
async function uploadBuffer(buffer, key, contentType) {
    const command = new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        Body: buffer,
        ContentType: contentType,
    });

    try {
        const response = await s3.send(command);
        return response;
    } catch (error) {
        console.error(`Upload failed for ${key}:`, error.message);
        throw error;
    }
}

async function getCID(key) {
    try {
        const command = new HeadObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
        });
        const response = await s3.send(command);
        // Filebase stores CID in x-amz-meta-cid
        return response.Metadata?.cid || response.Metadata?.['x-amz-meta-cid'];
    } catch (error) {
        console.error(`Failed to get CID for ${key}:`, error.message);
        return null;
    }
}

// Helper: Load State from Disk
async function loadState() {
    console.log("Checking for existing progress...");

    // Ensure directories exist
    await fs.ensureDir(IMAGE_DIR);
    await fs.ensureDir(METADATA_DIR);

    const files = await fs.readdir(METADATA_DIR);
    const jsonFiles = files.filter(f => f.endsWith('.json'));

    let maxId = 0;

    for (const file of jsonFiles) {
        try {
            const filePath = path.join(METADATA_DIR, file);
            const data = await fs.readJson(filePath);

            // Update Max ID
            const id = parseInt(file.replace('.json', ''));
            if (id > maxId) maxId = id;

            // Add to allMetadata
            allMetadata.push({
                ...data,
                tokenId: id,
                metadataCID: ""
            });

            // Update Rarity
            data.attributes.forEach(attr => {
                const category = attr.trait_type.toLowerCase() + 's'; // Background -> backgrounds
                const value = attr.value;
                if (rarityCounts[category] && rarityCounts[category][value] !== undefined) {
                    rarityCounts[category][value]++;
                }
            });

        } catch (err) {
            console.error(`Error reading ${file}:`, err.message);
        }
    }

    return maxId + 1;
}

async function generate() {
    // Load previous state
    const startId = await loadState();

    console.log(`Resuming generation from #${startId} of ${TOTAL_SUPPLY}...`);

    let id = startId;
    while (id <= TOTAL_SUPPLY) {
        try {
            // 1. Select Traits
            const background = getRandomTrait('backgrounds');
            const accessory = getRandomTrait('accessories');
            const pose = getRandomTrait('poses');
            const color = getRandomTrait('colors');

            // 2. Generate Image
            const prompt = `chibi spiderman prehistoric stone age tribal style, ${background}, ${accessory}, ${pose}, ${color}`;
            const encodedPrompt = encodeURIComponent(prompt);
            const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}`;

            console.log(`[${id}/${TOTAL_SUPPLY}] Generating: ${prompt}`);

            const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
            const imageBuffer = Buffer.from(imageResponse.data);
            const imageFileName = `${id}.png`;
            const imagePath = path.join(IMAGE_DIR, imageFileName);

            await fs.writeFile(imagePath, imageBuffer);

            // 3. Upload Image
            let imageCID = "";
            let metadataCID = "";

            if (process.env.FILEBASE_KEY && process.env.FILEBASE_BUCKET) {
                await uploadBuffer(imageBuffer, imageFileName, 'image/png');
                imageCID = await getCID(imageFileName);

                if (!imageCID) {
                    console.warn(`Warning: Could not retrieve CID for image ${id}`);
                }
            }

            // 4. Create Metadata
            const metadata = {
                name: `Tribal Spidey #${id}`,
                description: "A collection of prehistoric tribal Spiderman chibis.",
                image: imageCID ? `ipfs://${imageCID}` : `file://${imageFileName}`,
                attributes: [
                    { trait_type: "Background", value: background },
                    { trait_type: "Accessory", value: accessory },
                    { trait_type: "Pose", value: pose },
                    { trait_type: "Color", value: color }
                ],
                compiler: "Antigravity Engine"
            };

            const metadataFileName = `${id}.json`;
            const metadataPath = path.join(METADATA_DIR, metadataFileName);
            await fs.writeJson(metadataPath, metadata, { spaces: 2 });

            // 5. Upload Metadata
            if (process.env.FILEBASE_KEY && process.env.FILEBASE_BUCKET) {
                const metadataBuffer = Buffer.from(JSON.stringify(metadata));
                await uploadBuffer(metadataBuffer, metadataFileName, 'application/json');
                metadataCID = await getCID(metadataFileName);
            }

            // Store for batch
            allMetadata.push({
                ...metadata,
                tokenId: id,
                metadataCID: metadataCID
            });

            // Update Rarity (Only if successful)
            rarityCounts.backgrounds[background]++;
            rarityCounts.accessories[accessory]++;
            rarityCounts.poses[pose]++;
            rarityCounts.colors[color]++;

            console.log(`[${id}/${TOTAL_SUPPLY}] Done. ImgCID: ${imageCID} | MetaCID: ${metadataCID}`);

            // Success! Increment ID
            id++;

            // Rate limiting
            await sleep(DELAY_MS);

        } catch (error) {
            console.error(`Error generating #${id}:`, error.message);
            console.log(`Retrying #${id} in 3 seconds...`);
            await sleep(3000); // Wait longer before retry
        }
    }

    // 6. Generate Reports
    console.log("Generating reports...");
    await fs.writeJson('metadata.json', allMetadata, { spaces: 2 });

    const rarityReport = {
        totalSupply: TOTAL_SUPPLY,
        traits: rarityCounts
    };
    await fs.writeJson('rarity.json', rarityReport, { spaces: 2 });

    console.log("All done!");
}

generate();
