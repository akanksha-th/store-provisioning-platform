import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './App.css';

// ============================================
// Using environment variable for API URL
// ============================================
const API_URL = process.env.REACT_APP_API_URL || '/api';

// ============================================
// MAIN COMPONENT
// ============================================
function App() {
  // STATE - Data that changes in our app
  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(false);
  
  // ============================================
  // LOAD STORES WHEN APP STARTS
  // ============================================
  useEffect(() => {
    loadStores();
    
    // Refresh every 5 seconds to check status updates
    const interval = setInterval(loadStores, 5000);
    
    // Cleanup when component unmounts
    return () => clearInterval(interval);
  }, []);
  
  // ============================================
  // FUNCTIONS
  // ============================================
  
  // Load stores from backend
  const loadStores = async () => {
    try {
      const response = await axios.get(`${API_URL}/stores`);
      setStores(response.data.stores);
    } catch (error) {
      console.error('Failed to load stores:', error);
    }
  };
  
  // Create new store
  const createStore = async () => {
    setLoading(true);
    try {
      await axios.post(`${API_URL}/stores/create`);
      await loadStores(); // Refresh the list
      alert('Store creation started! Wait for status to change to Ready.');
    } catch (error) {
      console.error('Failed to create store:', error);
      alert('Failed to create store: ' + error.message);
    }
    setLoading(false);
  };
  
  // Delete store
  const deleteStore = async (storeId) => {
    if (!window.confirm('Are you sure you want to delete this store?')) {
      return;
    }
    
    try {
      const response = await axios.delete(`${API_URL}/stores/${storeId}`);
      
      // Check if actually successful
      if (response.data.success) {
        await loadStores(); // Refresh the list
        // Don't show alert - just let the store disappear from list
      } else {
        alert('Failed to delete store: ' + (response.data.error || 'Unknown error'));
      }
    } catch (error) {
      console.error('Failed to delete store:', error);
      
      // Check if it's actually a success (status 200) but axios treating as error
      if (error.response && error.response.status === 200) {
        await loadStores(); // Refresh anyway
        return; // Don't show error
      }
      
      // Only show error if it truly failed
      if (error.response) {
        alert('Failed to delete store: ' + (error.response.data.error || error.message));
      } else {
        alert('Failed to delete store: Network error');
      }
    }
  };
  
  // ============================================
  // RENDER UI
  // ============================================
  return (
    <div className="App">
      <header className="App-header">
        <h1>🏪 Store Provisioning Platform</h1>
        <p>Create and manage WooCommerce stores</p>
      </header>
      
      <main className="container">
        {/* CREATE BUTTON */}
        <div className="create-section">
          <button 
            onClick={createStore} 
            disabled={loading}
            className="create-button"
          >
            {loading ? '⏳ Creating...' : '➕ Create New Store'}
          </button>
        </div>
        
        {/* STORES LIST */}
        <div className="stores-section">
          <h2>Your Stores ({stores.length})</h2>
          
          {stores.length === 0 ? (
            <p className="empty-state">No stores yet. Create your first store!</p>
          ) : (
            <div className="stores-grid">
              {stores.map(store => (
                <div key={store.id} className="store-card">
                  <div className="store-header">
                    <h3>{store.name}</h3>
                    <span className={`status status-${store.status}`}>
                      {store.status}
                    </span>
                  </div>
                  
                  <div className="store-details">
                    <p><strong>ID:</strong> {store.id}</p>
                    <p><strong>Port:</strong> {store.port}</p>
                    <p><strong>Created:</strong> {new Date(store.createdAt).toLocaleString()}</p>
                    
                    {store.status === 'ready' && (
                      <a 
                        href={store.url} 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="store-link"
                      >
                        🔗 Open Store
                      </a>
                    )}
                  </div>
                  
                  <button 
                    onClick={() => deleteStore(store.id)}
                    className="delete-button"
                  >
                    🗑️ Delete
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export default App;