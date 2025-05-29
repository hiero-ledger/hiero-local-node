# Multinode with Block Node Configuration Overview

## Default Configuration
By default, the block node functionality is disabled in the multinode setup. When enabled, the system uses a 2:1 configuration, meaning:
- 2 consensus nodes point to 1 block node
- Total of 4 consensus nodes with 2 block nodes
- Block nodes run on ports 8080 (default - block-node) and 8083 (block-node-1) by default

## Custom Configuration
To create a custom configuration (e.g., 1:1 mapping with 4 consensus nodes and 4 block nodes), follow these steps:

### 1. Create Block Node Configuration Files
Create new JSON configuration files in the `CNtoBNConfig` folder for each additional block node. For example:

```json
// CNtoBNConfig/2to1/CN3/block-nodes.json
{
  "nodes": [
    {
      "address": "block-node-2",
      "port": 8084
    }
  ],
  "blockItemBatchSize": 256
}

// CNtoBNConfig/2to1/CN4/block-nodes.json
{
  "nodes": [
    {
      "address": "block-node-3",
      "port": 8085
    }
  ],
  "blockItemBatchSize": 256
}
```

### 2. Update Block Node Docker Compose
Add new block node services in `docker-compose.multinode.blocknode.yml`:

```yaml
block-node-2:
  image: "${BLOCK_NODE_IMAGE_PREFIX}hiero-block-node:${BLOCK_NODE_IMAGE_TAG}"
  container_name: block-node-2
  networks:
    network-node-bridge:
      ipv4_address: 172.27.0.7
    mirror-node:
  environment:
    VERSION: ${BLOCK_NODE_IMAGE_TAG}
    REGISTRY_PREFIX: ${BLOCK_NODE_REGISTRY_PREFIX}
    BLOCKNODE_STORAGE_ROOT_PATH: ${BLOCK_NODE_STORAGE_ROOT_PATH}
    JAVA_OPTS: ${BLOCK_NODE_JAVA_OPTS}
    SERVER_PORT: 8084
  ports:
    - "8084:8084"

block-node-3:
  image: "${BLOCK_NODE_IMAGE_PREFIX}hiero-block-node:${BLOCK_NODE_IMAGE_TAG}"
  container_name: block-node-3
  networks:
    network-node-bridge:
      ipv4_address: 172.27.0.8
    mirror-node:
  environment:
    VERSION: ${BLOCK_NODE_IMAGE_TAG}
    REGISTRY_PREFIX: ${BLOCK_NODE_REGISTRY_PREFIX}
    BLOCKNODE_STORAGE_ROOT_PATH: ${BLOCK_NODE_STORAGE_ROOT_PATH}
    JAVA_OPTS: ${BLOCK_NODE_JAVA_OPTS}
    SERVER_PORT: 8085
  ports:
    - "8085:8085"
```

### 3. Update Consensus Node Volumes
In `docker-compose.multinode.yml`, update the volume mappings for consensus nodes to point to the correct block node configurations. Find the `volumes` section for each network node and update as follows:

For `network-node-2`:
```yaml
volumes:
  - "${APPLICATION_CONFIG_PATH}/CNtoBNConfig/2to1/CN2/block-nodes.json:/opt/hgcapp/data/config/block-nodes.json"
```

For `network-node-3`:
```yaml
volumes:
  - "${APPLICATION_CONFIG_PATH}/CNtoBNConfig/2to1/CN3/block-nodes.json:/opt/hgcapp/data/config/block-nodes.json"
```

### 4. Port Configuration
- Default block node uses port 8080
- block-node-1 uses port 8083
- block-node-2 uses port 8084
- block-node-3 uses port 8085
- First consensus node always connects to block node on port 8080 using the default `block-nodes.json`
- Other consensus nodes use their respective configuration files

## Starting the System
To start the multinode system with block nodes enabled:

```bash
npm run start:multinode:block-node
```

## Important Notes
- Ensure unique IP addresses for each block node in the network configuration
- Maintain consistent port numbering across all configuration files
- Verify all volume mappings are correct before starting the system
- The first consensus node's configuration remains unchanged, using the default block node setup 