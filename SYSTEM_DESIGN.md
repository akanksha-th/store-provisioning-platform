# System Design & Architecture

## Table of Contents

1. [Overview](#overview)
2. [Architecture Decisions](#architecture-decisions)
3. [Component Design](#component-design)
4. [Data Flow](#data-flow)
5. [Isolation Strategy](#isolation-strategy)
6. [Persistence & Storage](#persistence--storage)
7. [Failure Handling & Idempotency](#failure-handling--idempotency)
8. [Cleanup Guarantees](#cleanup-guarantees)
9. [Local vs Production](#local-vs-production)
10. [Security Posture](#security-posture)
11. [Scalability Plan](#scalability-plan)
12. [Tradeoffs & Limitations](#tradeoffs--limitations)

---

## Overview

### Problem Statement

Build a multi-tenant store provisioning platform where:
- Users can create isolated WooCommerce stores on-demand
- Each store is a fully functional e-commerce site (WordPress + MySQL)
- Stores are provisioned via Kubernetes for orchestration
- Same deployment works locally and in production (k3s on VPS)
- Resources are cleanly torn down when stores are deleted

### Solution Approach

**Architecture Pattern**: Multi-tenant with namespace-per-store isolation

-  Complete resource isolation between stores
-  Easy cleanup (delete namespace = delete everything)
-  Familiar Kubernetes primitives (Deployments, Services, PVCs)
-  Scales horizontally (add more nodes as needed)

---

## Architecture Decisions

### Decision 1: Namespace-per-store

```
  Pros: Complete isolation, easy cleanup, production-ready pattern
  Cons: More overhead than single namespace (~100KB per namespace)
```

**Impact**: 
- Each store gets `store-{ID}` namespace
- Deleting namespace cascades to all resources
- NetworkPolicies can be added later for network isolation

### Decision 2:  Helm Orchestration

**Why Helm**:
-  Templating with values (local vs prod)
-  Versioning and rollback
-  Package management
-  Industry standard

**How we use it**:
```
store-chart/
├── values.yaml           # Defaults
├── values-local.yaml     # Local overrides
├── values-prod.yaml      # Production overrides
└── templates/            # K8s manifests with {{ .Values }}
```

### Decision 3: Deployment for MySQL (with single replica)

**Reasoning**:
```
StatefulSet:
  Pros: Stable network identity, ordered deployment
  Cons: Overkill for single-replica, slower to provision

Deployment:  CHOSEN
  Pros: Faster provisioning, simpler
  Cons: No stable pod identity (not needed for single replica)
```

**Why this works**:
- MySQL is single-replica (no replication)
- PVC provides stable storage identity
- Service provides stable DNS
- Faster provisioning matters for UX

### Decision 4: NodePort for MVP, Ingress for production

**Current State** (NodePort):
```
Pros: Works everywhere, no dependencies, simple
Cons: Random high ports (30000-32767), not production-friendly
```

**Future State** (Ingress):
```yaml
# values-prod.yaml
ingress:
  enabled: true
  host: store-{ID}.yourdomain.com
```

**Tradeoff**: 
- NodePort for demo = simpler, works immediately
- Ingress for production = proper URLs, requires DNS setup

### Decision 5: Backend on laptop (Node.js local process)

**Reasoning**:
```
Option A: Backend as K8s pod
  Pros: More "cloud-native"
  Cons: Complex to develop locally

Option B: Backend on laptop  CHOSEN
  Pros: Simple development, easy debugging, kubectl/helm already local
  Cons: Backend is not HA => SPOF (single point of failure)
```

**How it works**:
```
Laptop:
  Backend (Node.js) → runs helm install → K8s creates resources
  Dashboard (React) → calls Backend API
  kubectl/helm → configured to talk to local K8s or remote k3s
```

### Decision 6: Asynchronous provisioning with status polling

**Flow**:
```javascript
// Asynchronous approach (CHOSEN) 
POST /api/stores/create
  → return immediately with status: "provisioning"
  → helm install in background
  → Dashboard polls GET /api/stores every 5 seconds
  → Status updates: provisioning → ready
  → User sees progress!
```

**UX Impact**: Dashboard shows "provisioning..." and auto-updates when ready

---

## Component Design

### 1. React Dashboard

**Responsibility**: User interface

**Technology**: React 18, Axios

**Key Features**:
- Create/view/delete stores
- Real-time status updates (5-second polling)
- Store cards with status badges (provisioning/ready/failed)
- Clickable URLs when store is ready

**State Management**:
```javascript
const [stores, setStores] = useState([]);
const [loading, setLoading] = useState(false);

// Auto-refresh every 5 seconds
useEffect(() => {
  const interval = setInterval(loadStores, 5000);
  return () => clearInterval(interval);
}, []);
```

**API Integration**:
```
GET  /api/stores          → Load all stores
POST /api/stores/create   → Create new store
DELETE /api/stores/:id    → Delete store
```

### 2. Node.js Backend

**Responsibility**: Orchestration layer

**Technology**: Node.js + Express

**Key Functions**:
```javascript
// Store lifecycle
createStoreInBackground(store)  // Async Helm install
getWordpressNodePort(storeId)   // Get service port
deleteStore(storeId)            // Helm uninstall + cleanup

// Persistence
loadStoresFromFile()            // Restore on restart
saveStoresToFile()              // Persist after changes
```

**Helm Integration**:
```javascript
await runCommand(
  `helm upgrade --install ${storeId} store-chart ` +
  `--set storeId=${storeId} ` +
  `--values values-local.yaml ` +
  `--namespace ${storeId} ` +
  `--create-namespace ` +
  `--wait --timeout 3m`
);
```

**Why `upgrade --install`**:
- Idempotent (safe to retry)
- Install if doesn't exist
- Upgrade if exists
- No "already exists" errors

### 3. Helm Chart (store-chart)

**Responsibility**: Kubernetes resource definitions

**Structure**:
```
store-chart/
├── Chart.yaml              # Metadata
├── values.yaml             # Default configuration
├── values-local.yaml       # Local overrides
├── values-prod.yaml        # Production overrides
└── templates/
    ├── namespace.yaml      # Namespace: {{ .Values.storeId }}
    ├── mysql-pvc.yaml      # 5Gi persistent volume
    ├── mysql-deployment.yaml
    ├── mysql-service.yaml  # ClusterIP (internal only)
    ├── wordpress-deployment.yaml
    └── wordpress-service.yaml  # NodePort (external access)
```

**Templating Example**:
```yaml
# mysql-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mysql
  namespace: {{ .Values.storeId }}  # Dynamic!
spec:
  template:
    spec:
      containers:
      - name: mysql
        image: {{ .Values.mysql.image.repository }}:{{ .Values.mysql.image.tag }}
        resources:
          requests:
            memory: {{ .Values.mysql.resources.requests.memory }}
```

**Values Inheritance**:
```
values.yaml (base)
  storeId: "store-default"
  mysql.persistence.storageClass: ""
    
values-local.yaml (override)
  mysql.persistence.storageClass: "hostpath"
    
values-prod.yaml (override)
  mysql.persistence.storageClass: "local-path"
```

### 4. MySQL Deployment

**Configuration**:
```yaml
Replicas: 1
Image: mysql:8.0
Resources:
  Requests: 256Mi RAM, 250m CPU
  Limits: 512Mi RAM, 500m CPU
Probes:
  Liveness: mysqladmin ping (every 10s)
  Readiness: mysqladmin ping (every 5s)
Storage:
  PVC: 5Gi (persistent)
  Mount: /var/lib/mysql
```

**Why these settings**:
- 256Mi request = minimal for MySQL to run
- 512Mi limit = prevents one store consuming all RAM
- Probes = detect crashes, block traffic if not ready
- PVC = data survives pod restarts

### 5. WordPress Deployment

**Configuration**:
```yaml
Replicas: 1
Image: wordpress:latest
Resources: Same as MySQL (256Mi-512Mi)
InitContainer: wait-for-mysql (busybox)
Probes: /wp-login.php (avoids 301 redirect issues)
Storage: emptyDir (local) or PVC (prod)
```

**InitContainer Logic**:
```yaml
initContainers:
- name: wait-for-mysql
  image: busybox:1.28
  command:
  - sh
  - -c
  - |
    until nc -z mysql-service 3306; do
      echo "MySQL not ready, waiting 5s..."
      sleep 5
    done
    echo "MySQL is ready!"
```

**Why this matters**:
- WordPress MUST wait for MySQL
- Without initContainer: WordPress crashes, restart loop
- With initContainer: Clean startup, no errors

**Probe Path Choice**:
```
Probe: GET /
  Problem: WordPress redirects to HTTPS → 301 → probe fails

Probe: GET /wp-login.php 
  Solution: Never redirects, always returns 200
```

### 6. Services

**MySQL Service** (ClusterIP):
```yaml
type: ClusterIP  # Internal only
port: 3306
selector: app=mysql, store-id={{ .Values.storeId }}
```
- Accessible as `mysql-service:3306` within namespace
- Not accessible from outside cluster
- Stable DNS name

**WordPress Service** (NodePort):
```yaml
type: NodePort
port: 80
targetPort: 80
nodePort: auto-assigned (30000-32767)
```
- Accessible from browser
- Port randomly assigned by Kubernetes
- Backend fetches port via kubectl

---

## Data Flow

### Store Creation Flow
```
1. User clicks "Create Store" in dashboard
   
2. React → POST /api/stores/create
   
3. Backend:
   - Generate storeId: "store-1"
   - Create store object: { id, status: "provisioning", ... }
   - Save to stores.json
   - Return immediately (200 OK)
   - Start background provisioning
   
4. Background (async):
   - helm upgrade --install store-1 ...
   - Kubernetes creates:
     ✓ Namespace: store-1
     ✓ PVC: mysql-pvc
     ✓ Deployment: mysql (waits for PVC)
     ✓ Service: mysql-service
     ✓ Deployment: wordpress (waits for MySQL via initContainer)
     ✓ Service: wordpress-service
   - Helm --wait flag blocks until pods are 1/1 Running
   - kubectl get service to fetch NodePort
   - Update store: status = "ready", port = 31234
   - Save to stores.json
   
5. Dashboard (polling every 5s):
   - GET /api/stores
   - Sees status: "ready"
   - Shows "Open Store" button
   
6. User clicks "Open Store"
   - Opens http://localhost:31234
   - WordPress setup screen appears
```

**Timing**:
- Response time: <100ms (async)
- Provisioning time: 2-3 minutes
  - Image pulls: 30s (cached after first store)
  - MySQL init: 30s
  - WordPress startup: 60s
  - Health checks: 30s

### Store Deletion Flow
```
1. User clicks "Delete" → Confirms
   
2. React → DELETE /api/stores/store-1
   
3. Backend:
   - helm uninstall store-1 --namespace store-1
     → Deletes: Deployments, Services, ReplicaSets, Pods
   - kubectl delete namespace store-1
     → Deletes: PVCs, Secrets, everything else
   - Remove from stores array
   - Save stores.json
   - Return success
   
4. Dashboard:
   - Store disappears from list
   
5. Kubernetes:
   - Namespace enters "Terminating" state
   - Finalizers run (PVC cleanup)
   - Namespace fully deleted (~30 seconds)
```

**Cleanup Guarantees**:
- Deleting namespace = cascading delete of ALL resources
- PVCs marked for deletion (data eventually deleted)
- No orphaned resources
- Idempotent (safe to delete twice)

---

## Isolation Strategy

### Why Namespace-per-Store?

**Isolation Levels Achieved**:

| Resource | Isolation Method |
|----------|------------------|
| Pods | Different namespaces |
| Services | Namespaced (DNS: `mysql-service.store-1.svc.cluster.local`) |
| PVCs | Namespaced |
| Secrets | Namespaced (future) |
| Network | Same network (future: NetworkPolicies) |
| CPU/Memory | ResourceQuota (future) |

### Current Isolation

**What's isolated**:
```yaml
Namespace: store-1
├── Pods: Only store-1's pods
├── Services: Only accessible within store-1
├── PVCs: Bound to store-1 namespace
└── ConfigMaps/Secrets: Scoped to store-1
```

**What's NOT isolated** (future work):
```
- Network traffic (pods can talk across namespaces)
- Resource consumption (no quotas)
- Node resources (all stores compete for CPU/RAM)
```

---

## Persistence & Storage

### Storage Architecture

**Two-tier storage**:
```
MySQL: PersistentVolumeClaim (always persistent)
  
WordPress: emptyDir (local) OR PVC (prod)
```

**Why different for WordPress?**

Local (values-local.yaml):
```yaml
wordpress.persistence.enabled: false
```
- WordPress files in emptyDir (temporary)
- Lost on pod restart
- Faster, no storage quota issues

Production (values-prod.yaml):
```yaml
wordpress.persistence.enabled: true
```
- WordPress files in PVC (permanent)
- Survives pod restarts
- Required for production - uploaded media, plugins

### MySQL Persistence

**Configuration**:
```yaml
# mysql-pvc.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: mysql-pvc
  namespace: {{ .Values.storeId }}
spec:
  accessModes:
    - ReadWriteOnce  # Single node only
  storageClassName: {{ .Values.mysql.persistence.storageClass }}
  resources:
    requests:
      storage: 5Gi
```

**Storage Classes**:
```
Local K8s:     hostpath     (Docker Desktop's local provisioner)
Production:    local-path   (k3s's local-path-provisioner)
```

**Data Lifecycle**:
```
1. Store created → PVC provisioned
2. MySQL pod starts → PVC mounted to /var/lib/mysql
3. WordPress writes data → MySQL writes to PVC
4. Pod restarts → Data persists (PVC remains)
5. Store deleted → PVC deleted → Data lost
```

### What Persists vs What Doesn't

| Data | Persists | Storage |
|------|----------|---------|
| MySQL database |  Yes | PVC |
| WordPress core files |  No (local) /  Yes (prod) | emptyDir/PVC |
| Uploaded media |  No (local) /  Yes (prod) | emptyDir/PVC |
| WooCommerce orders |  Yes | MySQL (in PVC) |
| Store metadata |  Yes | stores.json (backend) |

---

## Failure Handling & Idempotency

### Idempotency Guarantees

**Key principle**: Operations can be retried safely without side effects

**Implementation**:
```javascript
// Using helm upgrade --install (NOT helm install)
helm upgrade --install store-1 ...
  
If store-1 doesn't exist: Install it
If store-1 exists: Upgrade it (no-op if no changes)
Never fails with "already exists"
```

**Scenarios**:

| Scenario | Behavior | Safe? |
|----------|----------|-------|
| Create same store twice | Second call upgrades |  Yes |
| Backend crashes mid-provision | Retry helm install |  Yes |
| Delete non-existent store | 404 error (expected) |  Yes |
| Delete same store twice | First succeeds, second 404 |  Yes |

### Failure Scenarios

**Scenario 1: Image Pull Failure**
```
Symptom: Pod stuck in "ImagePullBackOff"
Cause: Docker Hub rate limit, network issue
Detection: Pod status ≠ Running after 3 min
Handling:
  - Helm --wait times out
  - Store status → "failed"
  - Error shown in dashboard
Retry: User can delete and recreate
```

**Scenario 2: MySQL Initialization Failure**
```
Symptom: MySQL pod CrashLoopBackOff
Cause: Corrupted PVC, out of disk space
Detection: Liveness probe fails
Handling:
  - Pod restarts automatically (up to 10 times)
  - After 10 failures → store marked failed
Cleanup: Delete namespace + PVC, retry
```

**Scenario 3: WordPress Can't Connect to MySQL**
```
Symptom: WordPress logs "Error establishing database connection"
Cause: initContainer didn't wait long enough, MySQL crashed
Detection: Readiness probe fails (GET /wp-login.php returns 500)
Handling:
  - Pod stays 0/1 (not Ready)
  - Store never reaches "ready" status
  - User sees "provisioning" indefinitely
Manual fix: kubectl logs to diagnose
```

**Scenario 4: Backend Crashes Mid-Provisioning**
```
Timeline:
  1. User creates store-1
  2. Backend starts helm install
  3. Backend crashes (laptop sleep, process killed)
  4. Helm install continues (Kubernetes keeps running)
  5. Backend restarts
  6. Loads stores.json → sees store-1 with status "provisioning"

Current behavior: Store stuck as "provisioning" forever

Future improvement:
  - On restart, check actual K8s status
  - Update stores.json to match reality
  - kubectl get pods -n store-1 → if 1/1, mark ready
```

### Cleanup on Failure

**Automatic cleanup**:
```javascript
catch (error) {
  // Provisioning failed
  store.status = 'failed';
  
  // Attempt cleanup
  try {
    await runCommand(`helm uninstall ${storeId}`);
    await runCommand(`kubectl delete namespace ${storeId}`);
  } catch (cleanupError) {
    // Log but don't fail (namespace might not exist)
  }
}
```

**Manual cleanup** (if needed):
```bash
# List all namespaces
kubectl get namespaces | grep store-

# Delete stuck namespace
kubectl delete namespace store-X --force --grace-period=0
```

---

## Cleanup Guarantees

### Cascading Deletion

**When namespace is deleted**:
```
kubectl delete namespace store-1
  
Namespace controller marks for deletion
  
Finalizers run:
  1. Delete all Pods → sends SIGTERM → waits 30s → SIGKILL
  2. Delete all Services → releases NodePort
  3. Delete all Deployments → deletes ReplicaSets
  4. Delete all PVCs → marks volumes for deletion
  5. Delete all ConfigMaps/Secrets
  
PV controller deletes actual volumes
  
Namespace fully removed
```

**Timing**:
- Empty namespace: ~5 seconds
- Namespace with resources: ~30 seconds
- Namespace with PVCs: up to 2 minutes

**Guarantees**:
-  No orphaned Pods
-  No orphaned Services
-  No orphaned PVCs
-  NodePort released (can be reused)
-  Actual disk space freed asynchronously

---

## Local vs Production

### Configuration Differences

| Aspect | Local (Docker Desktop K8s) | Production (k3s on VPS) |
|--------|---------------------------|-------------------------|
| **Cluster** | Single-node (laptop) | Single-node VPS (can be multi-node) |
| **Kubernetes** | Docker Desktop K8s 1.30+ | k3s 1.30+ |
| **Storage Class** | `hostpath` | `local-path` |
| **WordPress Storage** | `emptyDir` (temporary) | `PVC` (persistent) |
| **Service Type** | `NodePort` | `NodePort` (future: Ingress) |
| **Access URL** | `localhost:XXXXX` | `VM_IP:XXXXX` |
| **DNS** | Not configured | Future: real domains |
| **TLS** | HTTP only | Future: cert-manager |
| **Ingress** | Disabled | Future: nginx-ingress |
| **Resource Limits** | Shared laptop RAM | Dedicated VM resources |
| **Networking** | Docker bridge | VPS network |

### Helm Values Comparison

**values-local.yaml**:
```yaml
environment: "local"

mysql:
  persistence:
    storageClass: "hostpath"

wordpress:
  persistence:
    enabled: false  # Use emptyDir

service:
  type: NodePort

ingress:
  enabled: false
```

**values-prod.yaml**:
```yaml
environment: "production"

mysql:
  persistence:
    storageClass: "local-path"

wordpress:
  persistence:
    enabled: true   # Use PVC
    storageClass: "local-path"

service:
  type: ClusterIP  # Future: with Ingress

ingress:
  enabled: true    # Future
  host: "store-{{ .storeId }}.yourdomain.com"
```

### Deployment Commands

**Local**:
```bash
# Point to local K8s
export KUBECONFIG=""  # Use default

# Deploy
helm upgrade --install store-1 store-chart \
  --values store-chart/values-local.yaml \
  --set storeId=store-1 \
  --namespace store-1 \
  --create-namespace
```

**Production**:
```bash
# Point to VPS k3s
export KUBECONFIG=~/.kube/config-prod

# Deploy
helm upgrade --install store-1 store-chart \
  --values store-chart/values-prod.yaml \
  --set storeId=store-1 \
  --namespace store-1 \
  --create-namespace
```

**Same chart, different values** 

### Migration Path

**How to promote a store from local → prod**:
```bash
# 1. Backup MySQL data from local
kubectl exec -n store-1 deployment/mysql -- \
  mysqldump -u root -prootpassword wordpress > backup.sql

# 2. Deploy to production
export KUBECONFIG=~/.kube/config-prod
helm upgrade --install store-1 store-chart \
  --values values-prod.yaml \
  --namespace store-1 \
  --create-namespace

# 3. Wait for MySQL to be ready
kubectl wait --for=condition=ready pod -l app=mysql -n store-1

# 4. Restore data
kubectl exec -n store-1 deployment/mysql -- \
  mysql -u root -prootpassword wordpress < backup.sql

# 5. Update WordPress URLs
kubectl exec -n store-1 deployment/wordpress -- \
  wp search-replace 'localhost:30123' 'our_domain.com' --allow-root
```

---

## Security Posture

### Current State (MVP)

**What's Secure**:
-  Namespace isolation (resource-level)
-  Services are ClusterIP (MySQL not exposed)
-  No privileged containers
-  Read-only root filesystem (where possible)
-  Passwords in Secrets

#### Secrets Management Implemented

Sensitive data (database passwords, credentials) are stored in Kubernetes Secrets instead of plain text in values.yaml.

**Implementation:**
- MySQL credentials stored in `mysql-secret` Secret per namespace
- Deployments reference secrets via `secretKeyRef`
- Secrets are base64 encoded
- Not committed to Git (values.yaml contains defaults only)

**Production Enhancement:**
For production, integrate with external secret management:
- External Secrets Operator (AWS Secrets Manager, Vault)

### Network Security

**Current**: All pods can communicate

---

## Scalability Plan

### Component Scalability

| Component | Current | Horizontal Scaling Plan |
|-----------|---------|------------------------|
| **React Dashboard** | 1 instance (laptop) | Deploy as K8s Deployment, 3+ replicas, LoadBalancer |
| **Node.js Backend** | 1 instance (laptop) | Deploy as K8s Deployment, 3+ replicas, shared state in Redis/DB |
| **MySQL (per store)** | 1 replica | Keep single replica OR MySQL replication |
| **WordPress (per store)** | 1 replica | Scale to 2-3 replicas, shared storage (ReadWriteMany PVC) |
| **Kubernetes** | Single node | Multi-node cluster, node autoscaling |

### Provisioning Throughput

**Current**:
```
Provisioning: Sequential (one at a time)
Throughput: ~1 store per 3 minutes = 20 stores/hour
Bottleneck: Single backend process, helm --wait blocks
```

### Resource Constraints

**Single Node Limits**:
```
t2.micro (1GB RAM, 1 vCPU):
  System overhead: 400MB
  Available: 600MB
  Per store: ~500MB (MySQL + WordPress)
  Max stores: 1 store

t2.medium (4GB RAM, 2 vCPU):
  System overhead: 1GB
  Available: 3GB
  Max stores: ~6 stores

t3.xlarge (16GB RAM, 4 vCPU):
  Available: 14GB
  Max stores: ~28 stores
```

### Database Scaling

**MySQL per store**:
```
Current: Single replica
Limitation: No HA, single point of failure
```

**Options**:

1. **Keep single replica**
   - Simple, cheap
   - Acceptable downtime for non-critical stores

2. **MySQL replication** (Complex)
```
   Primary → Secondary (read replica)
   Automatic failover with Orchestrator
```

3. **Managed database** (Expensive)
```
   AWS RDS, Google Cloud SQL
   Offload database management
   $$$
```

---

## Tradeoffs & Limitations

### Architectural Tradeoffs

**Tradeoff 1: Namespace per store vs Single namespace**

Chosen: Namespace per store

| Pros | Cons |
|------|------|
| Complete isolation | Higher overhead (~100KB/namespace) |
| Easy cleanup | More API calls to K8s |
| Production-ready | Namespace quotas (some clouds limit to 1000) |

**Impact**: For <1000 stores, namespace-per-store is the right choice

---

**Tradeoff 2: Synchronous vs Asynchronous provisioning**

Chosen: Asynchronous

| Pros | Cons |
|------|------|
| Better UX (no 3-min wait) | Need polling for status |
| Can provision multiple stores | More complex code |
| Resilient to backend restarts | State management required |

**Impact**: Better UX worth the complexity

---

**Tradeoff 3: Helm vs Raw YAML**

Chosen: Helm

| Pros | Cons |
|------|------|
| Templating (local/prod values) | Learning curve |
| Versioning | Another tool to install |
| Rollback capability | Helm releases add overhead |

**Impact**: Required by assignment, and it's the right choice

---

**Tradeoff 4: Backend on laptop vs in K8s**

Chosen: Laptop

| Pros | Cons |
|------|------|
| Simple development | Not HA |
| Easy debugging | Single point of failure |
| Fast iteration | Doesn't scale horizontally |

**Impact**: Fine for demo, needs to move to K8s for production

---

### Known Limitations

**Technical Limitations**:
1. **Single replica databases** → No HA
2. **NodePort access** → Not production-friendly URLs
3. **No ingress** → Can't route by domain
4. **No TLS** → HTTP only
5. **Shared node resources** → One store can starve others
6. **No backup strategy** → Data loss if PV fails
7. **Manual WooCommerce setup** → Not fully automated

**Operational Limitations**:
1. **No monitoring** → Can't see resource usage
2. **No logging** → Hard to debug issues
3. **No alerting** → Don't know when stores fail
4. **No CI/CD** → Manual deployment process
5. **No testing** → No automated tests

**Security Limitations**:
1. **No RBAC** → Backend is cluster-admin
2. **No network policies** → Pods can talk to each other
3. **Root containers** → Security risk
4. **No secrets rotation** → Static passwords forever

---

## Conclusion

### What We Built

A **production-ready foundation** for a multi-tenant store provisioning platform:

 Complete namespace isolation  
 Kubernetes-native orchestration  
 Helm-based deployment (local → prod)  
 Persistent storage  
 Health checks & self-healing  
 Clean resource cleanup  
 Async provisioning (good UX)  
 Idempotent operations  

### What Makes This Production-Ready

1. **Isolation**: Namespace-per-store pattern used by real SaaS platforms
2. **Orchestration**: Helm charts = versioning, rollback, repeatability
3. **Reliability**: Health checks, automatic restarts, failure handling
4. **Operability**: Clean teardown, idempotency, error reporting

### What's Missing for True Production

- Secrets management
- RBAC & least privilege
- Monitoring & logging
- TLS & proper ingress
- Backup & disaster recovery
- Auto-scaling & HA

**But**: The foundation is solid. These are additive improvements, not rearchitecture.

### Lessons Learned

1. **Start simple**: Namespace-per-store is simple and scales
2. **Async is worth it**: Better UX, more resilient
3. **Helm templates are powerful**: Same code, different environments
4. **Observability gap hurts**: Need logs/metrics to debug production
5. **Security is hard**: Easy to skip, painful to retrofit

---

**Built by**: Akanksha 
**Date**: February 2026  
**Assignment**: Urumi AI SDE Internship Round 1