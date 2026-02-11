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
const STORES_FILE = path.join(__dirname, 'stores.json');

// Load stores from file on startup
const loadStoresFromFile = () => {
    try {
        if (fs.existsSync(STORES_FILE)) {
            const data = fs.readFileSync(STORES_FILE, 'utf8');
            const parsed = JSON.parse(data);
            stores = parsed.stores || [];
            storeIdCounter = parsed.counter || 1;
            console.log(`Loaded ${stores.length} stores from file`);
        }
    } catch (error) {
        console.log(`Could not load stores file: ${error.message}`);
        stores = [];
    }
};

// Save stores to file
const saveStoresToFile = () => {
    try {
        fs.writeFileSync(STORES_FILE, JSON.stringify({
            stores,
            counter: storeIdCounter
        }, null, 2));
    } catch (error) {
        console.log(`Could not save stores: ${error.message}`);
    }
};

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
        saveStoresToFile();

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
            await runCommand(`helm uninstall ${id} --namespace ${id}`);
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
        saveStoresToFile();
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
    console.log(`Starting k8s provisioning for ${store.id}...`);
    
    // Path to helm chart
    const chartPath = path.join(__dirname, '..', 'store-chart');
    const valuesPath =path.join(__dirname, '..', 'store-chart', 'values-local.yaml');
 
    // Install using Helm
    console.log(`Running helm install...`)
    await runCommand(
        `helm upgrade --install ${store.id} "${chartPath}" ` +
        `--set storeId=${store.id} ` +
        `--values "${valuesPath}" ` +
        `--namespace ${store.id} ` +
        `--create-namespace ` +
        `--wait ` +
        `--timeout 3m`
    );

    console.log(`Helm installation completed!`);
    console.log(`---`);

    // Get the NodePort
    const nodePort = await getWordpressNodePort(store.id);
    console.log(`WordPress accessible at port ${nodePort}`);
    
    // Update store with actual URL
    const storeIndex = stores.findIndex(s => s.id === store.id);
    if (storeIndex !== -1) {
      stores[storeIndex].status = 'ready';
      stores[storeIndex].port = nodePort;
      stores[storeIndex].url = `http://localhost:${nodePort}`;
      saveStoresToFile();
    }
    
    console.log(`Store ${store.id} is ready at ${store.url}`);
    console.log(`${'='.repeat(60)}\n`);
    
    } catch (error) {
        console.log(`${'='.repeat(60)}\n`);
        console.error(`Failed to create store ${store.id}:`);
        console.error(`Error message: ${error.message}`);
        console.error(`Error stack:`, error.stack);
        console.log(`${'='.repeat(60)}\n`);
        
        // Update status to failed
        const storeIndex = stores.findIndex(s => s.id === store.id);
        if (storeIndex !== -1) {
            stores[storeIndex].status = 'failed';
            stores[storeIndex].error = error.message;
            saveStoresToFile();
        }
        
        // Cleanup
        try {
            await runCommand(`helm uninstall ${store.id} --namespace ${store.id}`);
            await runCommand(`kubectl delete namespace ${store.id}`);
            console.log(`🧹 Cleanup completed`);
        } catch (cleanupError) {
            console.log(`⚠️  Cleanup: ${cleanupError.message}`);
        }
    }
}

const getWordpressNodePort = async (storeId) => {
    try {
        const output = await runCommand(
            `kubectl get service wordpress-service -n ${storeId} -o jsonpath="{.spec.ports[0].nodePort}"`
        );
        return output.trim();
    } catch (error) {
        console.error(`Failed to get NodePort: ${error.message}`);
        return null;
    }
};

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

loadStoresFromFile();

// START THE SERVER
app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
    console.log(`API endpoints:`);
    console.log(`   GET     http://localhost:${PORT}/api/stores`);
    console.log(`   POST    http://localhost:${PORT}/api/stores/create`);
    console.log(`   DELETE  http://localhost:${PORT}/api/stores/:id`);

    // Verify kubectl is available
    exec('kubectl version --client', (error, stdout) => {
        if (error) {
            console.log(`WARNING: kubectl not found!`);
            console.log(`   Make sure kubectl is installed and Kubernetes is running`);
        } else {
            console.log(`kubectl available`);
        }
    });
    
    // Verify helm is available
    exec('helm version', (error, stdout) => {
        if (error) {
            console.log(`WARNING: helm not found!`);
        } else {
            console.log(`helm available`);
        }
    });
});