// IMPORTS
const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

// SET-UP -> initialize server
const app = express();
const PORT = 5000;

// establish communication between react and nodejs
app.use(cors());
app.use(express.json());

// DATA STORAGE 
let stores = [];
let storeIdCounter = 1;

// HELPER FUNCTIONS
// runs terminal commands
const runCommand = (command) => {
    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(stdout);
        });
    });
};

// generates unique port for each store
const getNextAvailablePort = () => {
    const usedPorts = stores.map(s => s.port);
    let port = 8080;
    while (usedPorts.includes(port)) {
        port++;
    }
    return port;
};

// API ENDPOINTS
// GET - /api/stores -> list all stores
app.get('/api/stores', (req, res) => {
    res.json({ stores });
});

// POST - /api/stores/create -> create a new store
app.post('/api/stores/create', async(req, res) => {
    try {
        // generate unique id and port for this store
        const storeId = `store-${storeIdCounter++}`;
        const port = getNextAvailablePort();

        // create new store object
        const newStore = {
            id: storeId,
            name: `Store ${storeIdCounter - 1}`,
            port: port,
            status: 'provisioning',
            createdAt: new Date().toISOString(),
            url: `http://localhost:${port}`
        };

        // add to the stores array
        stores.push(newStore);

        // return immediately
        res.json({
            success: true,
            store: newStore
        });

        createStoreInBackground(newStore);
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// DELETE - /app/stores/:id -> delete a store
app.delete('/api/stores/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // find the store
        const store = stores.find(s => s.id === id);
        if (!store) {
            return res.status(404).json({
                success: false,
                error: error.message
            });
        }

        // delete using docker-compose
        const composeFile = path.join(__dirname, '..' , 'docker-compose', `${id}.yml`);
        if (fs.existsSync(composeFile)) {
            await runCommand(`docker-compose -f ${composeFile} down -v`);
            fdatasync.unlinkSync(composeFile);
        }      

        stores = stores.filter(s => s.id !== id);
        res.join({ success: true });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// BACKGROUND FUNCTIONS
async function createStoreInBackground(store) {
  try {
    console.log(`🔄 Starting creation of ${store.id}...`);
    
    // 1. Create docker-compose file for this store
    // NOTE: Using template literals properly - ${} will be replaced with actual values
    const composeContent = `version: '3.8'

services:
  wordpress:
    image: wordpress:latest
    restart: always
    ports:
      - "${store.port}:80"
    environment:
      WORDPRESS_DB_HOST: db
      WORDPRESS_DB_USER: wordpress
      WORDPRESS_DB_PASSWORD: wordpress
      WORDPRESS_DB_NAME: wordpress
    volumes:
      - ${store.id}-wordpress:/var/www/html

  db:
    image: mysql:8.0
    restart: always
    environment:
      MYSQL_DATABASE: wordpress
      MYSQL_USER: wordpress
      MYSQL_PASSWORD: wordpress
      MYSQL_ROOT_PASSWORD: rootpassword
    volumes:
      - ${store.id}-db:/var/lib/mysql
    command: '--default-authentication-plugin=mysql_native_password'

volumes:
  ${store.id}-wordpress:
  ${store.id}-db:
`;
    
    // 2. Save the file
    const composeFile = path.join(__dirname, '..', 'docker-compose', `${store.id}.yml`);
    console.log(`📝 Creating compose file: ${composeFile}`);
    console.log(`📝 Port will be: ${store.port}`); // DEBUG: Show what port we're using
    fs.writeFileSync(composeFile, composeContent);
    console.log(`✅ Compose file created`);
    
    // 3. Run docker-compose up
    console.log(`🐳 Running docker-compose up...`);
    const command = `docker-compose -f "${composeFile}" up -d`;
    console.log(`Command: ${command}`);
    
    const output = await runCommand(command);
    console.log(`Docker output: ${output}`);
    
    // 4. Wait a bit for WordPress to be ready
    console.log(`⏳ Waiting 15 seconds for WordPress to start...`);
    await new Promise(resolve => setTimeout(resolve, 15000));
    
    // 5. Update status to ready
    const storeIndex = stores.findIndex(s => s.id === store.id);
    if (storeIndex !== -1) {
      stores[storeIndex].status = 'ready';
    }
    
    console.log(`✅ Store ${store.id} is ready at ${store.url}`);
    
  } catch (error) {
    console.error(`❌ Failed to create store ${store.id}:`);
    console.error(`Error message: ${error.message}`);
    console.error(`Error stack:`, error.stack);
    
    const storeIndex = stores.findIndex(s => s.id === store.id);
    if (storeIndex !== -1) {
      stores[storeIndex].status = 'failed';
      stores[storeIndex].error = error.message;
        }
    }
}


// START THE SERVER
app.listen(PORT, () => {
    console.log(`Backend server running on https://localhost:${PORT}`);
    console.log(`API endpoints:`);
    console.log(`   GET     https://localhost:${PORT}/api/stores`);
    console.log(`   POST    https://localhost:${PORT}/api/store/create`);
    console.log(`   DELETE  https://localhost:${PORT}/api/stores/:id`);
});