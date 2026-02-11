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

const waitForHealthy = async (storeId, maxWaitSeconds = 180) => {
    const composeFile = path.join(__dirname, '..', 'docker-compose', `${storeId}.yml`);
    const startTime = Date.now();

    console.log(`Waiting for ${storeId} MySQL to become healthy...`);

    while ((Date.now() - startTime) / 1000 < maxWaitSeconds) {
        try {
            const output = await runCommand(`docker-compose -p ${storeId} -f "${composeFile}" ps`);

            if (output.includes('(healthy)') || output.includes('Up (healthy)')) {
                const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
                console.log(`${storeId} MySQL is healthy after ${elapsedSeconds} seconds`);
                return true;
            }

            const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
            console.log(`Still waiting... (${elapsedSeconds}s elapsed)`);

        } catch (error) {
            console.log(`Checking health (containers may still be starting)...`);
        }

        await new Promise(resolve => setTimeout(resolve, 3000));
    }
    
    throw new Error(`Timeout: ${storeId} MySQL did not become healthy within ${maxWaitSeconds} seconds`);
};

const verifyWordpressConnection = async (storeId, port) => {
    console.log(`Verifying Wordpress-MySQL connection for ${storeId}...`);
    const composeFile = path.join(__dirname, '..', 'docker-compose', `${storeId}.yml`);

    try {
        const logs = await runCommand(`docker-compose -p ${storeId} -f "${composeFile}" logs wordpress`);

        const errorPatterns = [
            'Error establishing a database connection',
            'MySQL Connection Error',
            'Can\'t connect to MySQL server',
            'Access denied for user',
            'Unknown database',
            'MySQL server has gone away'
        ];

        for (const pattern of errorPatterns) {
            if (logs.includes(pattern)) {
                console.error(`Found error in logs: "${pattern}"`);
                return false;
            }
        }

        console.log(`No database connection found in logs`);
        return true;

    } catch (error) {
        console.error(`Error checking WordPress logs: ${error.message}`);
        return true;
    }
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
        console.log(`Attempting to delete store: ${id}`);

        // find the store
        const store = stores.find(s => s.id === id);
        if (!store) {
            console.log(`Store ${id} not found`);
            return res.status(404).json({
                success: false,
                error: 'Store not found'
            });
        }

        // delete using docker-compose
        const composeFile = path.join(__dirname, '..' , 'docker-compose', `${id}.yml`);
        
        // Always try to stop containers, even if file doesn't exist
        try {
            console.log(`Stopping containers for ${id}...`);
            await runCommand(`docker-compose -p ${id} down -v 2>&1 || docker stop $(docker ps -aq --filter "name=${id}") 2>&1 || true`);
            console.log(`Containers stopped`);
        } catch (error) {
            console.log(`Error stopping containers (continuing anyway): ${error.message}`);
        }
        
        // Delete compose file if exists
        if (fs.existsSync(composeFile)) {
            try {
                fs.unlinkSync(composeFile);
                console.log(`Compose file deleted`);
            } catch (error) {
                console.log(`Warning: Could not delete file: ${error.message}`);
            }
        }

        // Remove from stores array
        stores = stores.filter(s => s.id !== id);
        console.log(`Store removed from list`);
        
        res.status(200).json({ success: true });

    } catch (error) {
        console.log(`Deletion failed: ${error.message}`);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// BACKGROUND FUNCTIONS
async function createStoreInBackground(store) {
  try {
    console.log(`Starting creation of ${store.id}...`);
    
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
    depends_on:
      db: 
        condition: service_healthy

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
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost", "-u", "root", "-prootpassword"]
      interval: 5s
      timeout: 5s
      retries: 20
      start_period: 60s

  wpcli:
    image: wordpress:cli
    depends_on:
      wordpress:
        condition: service_started
      db:
        condition: service_healthy
    volumes:
      - ${store.id}-wordpress:/var/www/html
      - ${path.resolve(__dirname, '..', 'docker-compose', 'wp-setup.sh').replace(/\\/g, '/')}:/wp-setup.sh:ro
    environment:
      WORDPRESS_DB_HOST: db
      WORDPRESS_DB_USER: wordpress
      WORDPRESS_DB_PASSWORD: wordpress
      WORDPRESS_DB_NAME: wordpress
      STORE_PORT: ${store.port}
    user: "33:33"
    entrypoint: ["/bin/sh", "-c", "sleep 15 && chmod +x /wp-setup.sh && /wp-setup.sh"]

volumes:
  ${store.id}-wordpress:
  ${store.id}-db:
`;
    
    // 2. Save the file
    const composeFile = path.join(__dirname, '..', 'docker-compose', `${store.id}.yml`);
    console.log(`Creating compose file: ${composeFile}`);
    console.log(`Port will be: ${store.port}`); // DEBUG: Show what port we're using
    fs.writeFileSync(composeFile, composeContent);
    console.log(`Compose file created`);
    
    // 3. Run docker-compose up
    console.log(`Running docker-compose up...`);
    const command = `docker-compose -p ${store.id} -f "${composeFile}" up -d`;
    console.log(`Command: ${command}`);
    
    const output = await runCommand(command);
    console.log(`Docker output: ${output}`);
    
    // 4. Wait a bit for WordPress to be ready
    console.log(`Waiting for MySQL health check...`);
    await waitForHealthy(store.id, 120);
    console.log(``);

    console.log(`MySQL is healthy! Waiting 10s for WordPress to fully start...`);
    await new Promise(resolve => setTimeout(resolve, 10000));
    console.log(``);
 
    const isConnected = await verifyWordpressConnection(store.id, store.port);
    console.log(``);
    
    if (!isConnected) {
        throw new Error('WordPress failed to connect to MySQL - check container logs');
    }
    
    // 5. Update status to ready
    const storeIndex = stores.findIndex(s => s.id === store.id);
    if (storeIndex !== -1) {
      stores[storeIndex].status = 'ready';
    }
    
    console.log(`${'='.repeat(60)}\n`);
    console.log(`Store ${store.id} is ready at ${store.url}`);
    console.log(`${'='.repeat(60)}\n`);
    
  } catch (error) {
    console.log(`${'='.repeat(60)}\n`);
    console.error(`Failed to create store ${store.id}:`);
    console.error(`Error message: ${error.message}`);
    console.error(`Error stack:`, error.stack);
    console.log(`${'='.repeat(60)}\n`);
    
    const storeIndex = stores.findIndex(s => s.id === store.id);
    if (storeIndex !== -1) {
      stores[storeIndex].status = 'failed';
      stores[storeIndex].error = error.message;
        }
    }
}

// UTILITY - Force cleanup all stores
app.post('/api/stores/cleanup', async (req, res) => {
    try {
        console.log('Force cleanup initiated...');
        
        // Stop all containers with our naming pattern
        await runCommand('docker ps -aq --filter "name=store-" | ForEach-Object { docker stop $_ } 2>&1 || true');
        await runCommand('docker ps -aq --filter "name=store-" | ForEach-Object { docker rm $_ } 2>&1 || true');
        
        // Delete all yml files
        const dockerComposeDir = path.join(__dirname, '..', 'docker-compose');
        const files = fs.readdirSync(dockerComposeDir);
        files.forEach(file => {
            if (file.startsWith('store-') && file.endsWith('.yml')) {
                fs.unlinkSync(path.join(dockerComposeDir, file));
            }
        });
        
        // Clear stores array
        stores = [];
        storeIdCounter = 1;
        
        console.log('Cleanup complete');
        res.json({ success: true, message: 'All stores cleaned up' });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});


// START THE SERVER
app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
    console.log(`API endpoints:`);
    console.log(`   GET     http://localhost:${PORT}/api/stores`);
    console.log(`   POST    http://localhost:${PORT}/api/stores/create`);
    console.log(`   DELETE  http://localhost:${PORT}/api/stores/:id`);
});