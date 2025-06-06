import * as vscode from 'vscode';
import { Client } from '@elastic/elasticsearch';

interface ClusterConfig {
    id: string;
    name: string;
    deploymentType: string;
    nodeUrl?: string;
    cloudId?: string;
    authMethod: string;
    disableSSL?: boolean;
}

interface ClusterExportData {
    name: string;
    deploymentType: string;
    nodeUrl?: string;
    cloudId?: string;
    authMethod: string;
    disableSSL?: boolean;
}

interface ClusterExportFile {
    version: string;
    exportDate: string;
    clusters: ClusterExportData[];
}

interface ClusterHealth {
    status: 'green' | 'yellow' | 'red' | 'unknown';
    clusterName: string;
    numberOfNodes: number;
    numberOfDataNodes: number;
    activePrimaryShards: number;
    activeShards: number;
    lastChecked: Date;
}

export class ESExplorerProvider implements vscode.TreeDataProvider<ExplorerItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ExplorerItem | undefined | void> = new vscode.EventEmitter<ExplorerItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<ExplorerItem | undefined | void> = this._onDidChangeTreeData.event;
    private clusters: Map<string, ClusterConfig> = new Map();
    private clients: Map<string, Client> = new Map();
    private clusterHealth: Map<string, ClusterHealth> = new Map();
    private activeClusterId: string | undefined;
    private context: vscode.ExtensionContext;
    private autoRefreshEnabled: boolean = false;
    private refreshTimer: NodeJS.Timeout | undefined;
    private dataStreamStatsSums: Map<string, { docCount: number | string, sizeBytes: number | string }> = new Map();
    private dataStreamParentItems: Map<string, ExplorerItem> = new Map();

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.loadClusters();
        // Load auto-refresh setting
        this.autoRefreshEnabled = context.globalState.get('esExt.autoRefreshEnabled', false);
        if (this.autoRefreshEnabled) {
            this.startAutoRefresh();
        }
    }

    getActiveClient(): Client | undefined {
        return this.activeClusterId ? this.clients.get(this.activeClusterId) : undefined;
    }

    // Public method to get a client by clusterId
    public getClient(clusterId?: string): Client | undefined {
        if (clusterId) return this.clients.get(clusterId);
        return this.getActiveClient();
    }

    getActiveCluster(): ClusterConfig | undefined {
        return this.activeClusterId ? this.clusters.get(this.activeClusterId) : undefined;
    }

    getCluster(clusterId: string): ClusterConfig | undefined {
        return this.clusters.get(clusterId);
    }

    setActiveCluster(clusterId: string) {
        this.activeClusterId = clusterId;
        this.refresh();
    }

    async loadClustersOnStartup(): Promise<void> {
        await this.loadClusters();
        
        // Auto-reconnect previously connected clusters
        await this.autoReconnectClusters();
        
        this.refresh();
    }

    async addCluster(config: ClusterConfig): Promise<void> {
        this.clusters.set(config.id, config);
        await this.saveClusterConfig(config);
        if (!this.activeClusterId) {
            this.activeClusterId = config.id;
        }
        this.refresh();
    }

    async removeCluster(clusterId: string): Promise<void> {
        this.clusters.delete(clusterId);
        this.clients.delete(clusterId);
        
        // Remove from connected clusters list for auto-reconnect
        await this.removeConnectedCluster(clusterId);
        
        await this.context.secrets.delete(`esExt.cluster.${clusterId}.config`);
        await this.context.secrets.delete(`esExt.cluster.${clusterId}.username`);
        await this.context.secrets.delete(`esExt.cluster.${clusterId}.password`);
        await this.context.secrets.delete(`esExt.cluster.${clusterId}.apiKey`);
        
        if (this.activeClusterId === clusterId) {
            this.activeClusterId = this.clusters.size > 0 ? Array.from(this.clusters.keys())[0] : undefined;
        }
        this.refresh();
    }

    toggleAutoRefresh(): void {
        this.autoRefreshEnabled = !this.autoRefreshEnabled;
        this.context.globalState.update('esExt.autoRefreshEnabled', this.autoRefreshEnabled);
        
        if (this.autoRefreshEnabled) {
            vscode.window.showInformationMessage('Auto-refresh enabled: Health status will update every 60 seconds');
            this.startAutoRefresh();
        } else {
            vscode.window.showInformationMessage('Auto-refresh disabled');
            this.stopAutoRefresh();
        }
    }

    private startAutoRefresh(): void {
        this.stopAutoRefresh(); // Clear any existing timer
        this.refreshTimer = setInterval(() => {
            this.refreshClusterHealth();
        }, 60000); // 60 seconds
        
        // Also refresh immediately
        this.refreshClusterHealth();
    }

    private stopAutoRefresh(): void {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = undefined;
        }
    }

    private async refreshClusterHealth(): Promise<void> {
        // Refresh health for all connected clusters
        for (const [clusterId, client] of this.clients) {
            try {
                const healthResponse: any = await client.cluster.health();
                const health = healthResponse.body || healthResponse;
                
                this.clusterHealth.set(clusterId, {
                    status: health.status || 'unknown',
                    clusterName: health.cluster_name || 'Unknown',
                    numberOfNodes: health.number_of_nodes || 0,
                    numberOfDataNodes: health.number_of_data_nodes || 0,
                    activePrimaryShards: health.active_primary_shards || 0,
                    activeShards: health.active_shards || 0,
                    lastChecked: new Date()
                });
            } catch (error) {
                // Set unknown status on error
                this.clusterHealth.set(clusterId, {
                    status: 'unknown',
                    clusterName: 'Unknown',
                    numberOfNodes: 0,
                    numberOfDataNodes: 0,
                    activePrimaryShards: 0,
                    activeShards: 0,
                    lastChecked: new Date()
                });
            }
        }
        
        this.refresh();
    }

    getAutoRefreshStatus(): boolean {
        return this.autoRefreshEnabled;
    }

    dispose(): void {
        this.stopAutoRefresh();
    }

    async connectToCluster(clusterId: string): Promise<boolean> {
        const config = this.clusters.get(clusterId);
        if (!config) {
            vscode.window.showErrorMessage(`Cluster ${clusterId} not found`);
            return false;
        }

        // --- Prompt for credentials if missing ---
        let credentials: any = {};
        if (config.authMethod === 'Basic: Username/Password') {
            let username = await this.context.secrets.get(`esExt.cluster.${clusterId}.username`);
            let password = await this.context.secrets.get(`esExt.cluster.${clusterId}.password`);
            if (!username || !password) {
                username = await vscode.window.showInputBox({ prompt: 'Username for ' + config.name });
                password = username ? await vscode.window.showInputBox({ prompt: 'Password', password: true }) : undefined;
                if (!username || !password) {
                    vscode.window.showWarningMessage('Username and password are required to connect.');
                    return false;
                }
                credentials = { username, password };
                await this.context.secrets.store(`esExt.cluster.${clusterId}.username`, username);
                await this.context.secrets.store(`esExt.cluster.${clusterId}.password`, password);
            }
        } else if (config.authMethod === 'API Key') {
            let apiKey = await this.context.secrets.get(`esExt.cluster.${clusterId}.apiKey`);
            if (!apiKey) {
                apiKey = await vscode.window.showInputBox({ prompt: 'API Key for ' + config.name });
                if (!apiKey) {
                    vscode.window.showWarningMessage('API Key is required to connect.');
                    return false;
                }
                credentials = { apiKey };
                await this.context.secrets.store(`esExt.cluster.${clusterId}.apiKey`, apiKey);
            }
        }
        // --- End prompt for credentials ---

        return vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Connecting to ${config.name}...`,
            cancellable: false
        }, async (progress) => {
            progress.report({ increment: 50, message: 'Establishing connection...' });
            
            try {
                const clientOptions: any = {};
                
                if (config.deploymentType === 'Elastic Cloud') {
                    clientOptions.cloud = { id: config.cloudId };
                } else {
                    clientOptions.node = config.nodeUrl;
                }

                // Use credentials if present
                if (config.authMethod === 'Basic: Username/Password') {
                    const username = await this.context.secrets.get(`esExt.cluster.${clusterId}.username`);
                    const password = await this.context.secrets.get(`esExt.cluster.${clusterId}.password`);
                    if (username && password) {
                        clientOptions.auth = { username, password };
                    }
                } else if (config.authMethod === 'API Key') {
                    const apiKey = await this.context.secrets.get(`esExt.cluster.${clusterId}.apiKey`);
                    if (apiKey) {
                        clientOptions.auth = { apiKey };
                    }
                }

                if (config.disableSSL) {
                    clientOptions.ssl = { rejectUnauthorized: false };
                    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
                }

                // Inject CA certificate if present
                const caCert = await this.context.globalState.get<string>('esExt.caCertificate');
                if (caCert) {
                    clientOptions.tls = clientOptions.tls || {};
                    clientOptions.tls.ca = Buffer.from(caCert, 'utf8');
                }

                progress.report({ increment: 30, message: 'Testing connection...' });
                const client = new Client(clientOptions);
                await client.ping();
                
                this.clients.set(clusterId, client);
                this.activeClusterId = clusterId;
                
                // Save connection state for auto-reconnect
                await this.saveConnectedCluster(clusterId);
                
                progress.report({ increment: 20, message: 'Connected successfully!' });
                
                // Fetch initial health status for this cluster
                try {
                    const healthResponse: any = await client.cluster.health();
                    const health = healthResponse.body || healthResponse;
                    
                    this.clusterHealth.set(clusterId, {
                        status: health.status || 'unknown',
                        clusterName: health.cluster_name || 'Unknown',
                        numberOfNodes: health.number_of_nodes || 0,
                        numberOfDataNodes: health.number_of_data_nodes || 0,
                        activePrimaryShards: health.active_primary_shards || 0,
                        activeShards: health.active_shards || 0,
                        lastChecked: new Date()
                    });
                } catch (healthError) {
                    // Set unknown status on health check error
                    this.clusterHealth.set(clusterId, {
                        status: 'unknown',
                        clusterName: 'Unknown',
                        numberOfNodes: 0,
                        numberOfDataNodes: 0,
                        activePrimaryShards: 0,
                        activeShards: 0,
                        lastChecked: new Date()
                    });
                }
                
                return true;
            } catch (err: any) {
                console.error(`[ESExt] Failed to connect to cluster ${clusterId}:`, err);
                vscode.window.showErrorMessage(`Failed to connect to ${config.name}: ${err.message}`);
                return false;
            }
        });
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ExplorerItem): vscode.TreeItem {
        // No mutation of label here; label is set at construction in getChildren/fetchDataStreams
        return element;
    }

    async getChildren(element?: ExplorerItem): Promise<ExplorerItem[]> {
        if (!element) {
            // Root level - show all clusters with their data
            const items: ExplorerItem[] = [];
            
            // If no clusters, show add button
            if (this.clusters.size === 0) {
                const addClusterItem = new ExplorerItem('Add Elasticsearch Cluster', 'addCluster', vscode.TreeItemCollapsibleState.None);
                addClusterItem.command = { command: 'esExt.addCluster', title: 'Add Cluster' };
                addClusterItem.iconPath = new vscode.ThemeIcon('add');
                return [addClusterItem];
            }

            // Show each cluster as a top-level expandable item
            for (const [id, config] of this.clusters) {
                const isActive = id === this.activeClusterId;
                const isConnected = this.clients.has(id);
                const health = this.clusterHealth.get(id);
                
                let statusText = '';
                let healthText = '';
                let healthIcon = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground'));
                if (isConnected) {
                    statusText = ' (Connected)';
                    
                    if (health) {
                        switch (health.status) {
                            case 'green':
                                healthText = ' (Healthy)';
                                healthIcon = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconPassed'));
                                break;
                            case 'yellow':
                                healthText = ' (Warning)';
                                healthIcon = new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
                                break;
                            case 'red':
                                healthText = ' (Critical)';
                                healthIcon = new vscode.ThemeIcon('error', new vscode.ThemeColor('editorError.foreground'));
                                break;
                            case 'unknown':
                                healthText = ' (Unknown)';
                                healthIcon = new vscode.ThemeIcon('question', new vscode.ThemeColor('disabledForeground'));
                                break;
                        }
                    }
                } else {
                    healthIcon = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground'));
                }
                
                // Add node information to the cluster label if connected and health data is available
                let nodeInfoText = '';
                if (isConnected && health) {
                    nodeInfoText = ` [${health.numberOfNodes} nodes, ${health.numberOfDataNodes} data]`;
                }
                
                const label = `${config.name}${statusText}${healthText}${nodeInfoText}`;
                const clusterItem = new ExplorerItem(label, `cluster:${id}`, vscode.TreeItemCollapsibleState.Collapsed);
                clusterItem.iconPath = healthIcon;
                clusterItem.tooltip = `${config.deploymentType} - ${config.nodeUrl || config.cloudId}${health ? `\nStatus: ${health.status}\nNodes: ${health.numberOfNodes}\nLast checked: ${health.lastChecked.toLocaleTimeString()}` : ''}`;
                items.push(clusterItem);
            }

            // Add cluster management button at the end
            const addItem = new ExplorerItem('Add Cluster', 'addCluster', vscode.TreeItemCollapsibleState.None);
            addItem.command = { command: 'esExt.addCluster', title: 'Add Cluster' };
            addItem.iconPath = new vscode.ThemeIcon('add');
            addItem.tooltip = 'Add a new Elasticsearch cluster';
            items.push(addItem);

            return items;
        }

        // Handle cluster expansion
        if (element.contextValue?.startsWith('cluster:')) {
            const clusterId = element.contextValue.split(':')[1];
            const config = this.clusters.get(clusterId);
            const isConnected = this.clients.has(clusterId);
            const items: ExplorerItem[] = [];

            if (!isConnected) {
                // Show connection options if not connected
                const connectItem = new ExplorerItem(`Connect to ${config?.name}`, 'connect', vscode.TreeItemCollapsibleState.None);
                connectItem.command = { 
                    command: 'esExt.connectToCluster', 
                    title: 'Connect', 
                    arguments: [clusterId] 
                };
                connectItem.iconPath = new vscode.ThemeIcon('plug');
                items.push(connectItem);

                const removeItem = new ExplorerItem('Remove Cluster', 'remove', vscode.TreeItemCollapsibleState.None);
                removeItem.command = { 
                    command: 'esExt.removeCluster', 
                    title: 'Remove', 
                    arguments: [clusterId] 
                };
                removeItem.iconPath = new vscode.ThemeIcon('trash');
                items.push(removeItem);

                return items;
            }

            // Show cluster data categories if connected
            const health = this.clusterHealth.get(clusterId);
            if (health) {
                const healthStatusText = `Health Status: ${health.status.toUpperCase()}`;
                const healthDetailsText = `${health.numberOfNodes} nodes, ${health.activeShards} shards`;
                const healthItem = new ExplorerItem(healthStatusText, `healthStatus:${clusterId}`, vscode.TreeItemCollapsibleState.None);
                const healthDetailsItem = new ExplorerItem(healthDetailsText, `healthDetails:${clusterId}`, vscode.TreeItemCollapsibleState.None);
                
                let healthIconName = 'pulse';
                let healthColor: vscode.ThemeColor;
                switch (health.status) {
                    case 'green': 
                        healthIconName = 'pass'; 
                        healthColor = new vscode.ThemeColor('testing.iconPassed');
                        break;
                    case 'yellow': 
                        healthIconName = 'warning'; 
                        healthColor = new vscode.ThemeColor('editorWarning.foreground');
                        break;
                    case 'red': 
                        healthIconName = 'error'; 
                        healthColor = new vscode.ThemeColor('editorError.foreground');
                        break;
                    case 'unknown': 
                        healthIconName = 'question'; 
                        healthColor = new vscode.ThemeColor('disabledForeground');
                        break;
                }
                healthItem.iconPath = new vscode.ThemeIcon(healthIconName, healthColor);
                healthDetailsItem.iconPath = new vscode.ThemeIcon('info');
                healthItem.tooltip = `Cluster: ${health.clusterName}\nStatus: ${health.status}\nNodes: ${health.numberOfNodes}\nData Nodes: ${health.numberOfDataNodes}\nActive Primary Shards: ${health.activePrimaryShards}\nActive Shards: ${health.activeShards}\nLast Checked: ${health.lastChecked.toLocaleString()}`;
                healthDetailsItem.tooltip = healthItem.tooltip;
                items.push(healthItem);
                items.push(healthDetailsItem);
            }
            
            items.push(
                new ExplorerItem('Cluster Info', `clusterInfo:${clusterId}`, vscode.TreeItemCollapsibleState.Collapsed, new vscode.ThemeIcon('info')),
                new ExplorerItem('Nodes', `nodes:${clusterId}`, vscode.TreeItemCollapsibleState.Collapsed, new vscode.ThemeIcon('server-environment')),
                new ExplorerItem('Important Links', `links:${clusterId}`, vscode.TreeItemCollapsibleState.Collapsed, new vscode.ThemeIcon('link-external')),
                new ExplorerItem('Data Streams', `dataStreams:${clusterId}`, vscode.TreeItemCollapsibleState.Collapsed, new vscode.ThemeIcon('database')),
                new ExplorerItem('Roles', `roles:${clusterId}`, vscode.TreeItemCollapsibleState.Collapsed, new vscode.ThemeIcon('person')),
                new ExplorerItem('Role Mappings', `roleMappings:${clusterId}`, vscode.TreeItemCollapsibleState.Collapsed, new vscode.ThemeIcon('organization')),
                new ExplorerItem('Index Templates', `indexTemplates:${clusterId}`, vscode.TreeItemCollapsibleState.Collapsed, new vscode.ThemeIcon('file-code'))
            );

            // Add management actions
            const divider = new ExplorerItem('───────────', 'divider', vscode.TreeItemCollapsibleState.None);
            divider.iconPath = new vscode.ThemeIcon('blank');
            items.push(divider);
            if (clusterId !== this.activeClusterId) {
                const selectItem = new ExplorerItem('Set as Active', 'select', vscode.TreeItemCollapsibleState.None);
                selectItem.command = { 
                    command: 'esExt.selectCluster', 
                    title: 'Select', 
                    arguments: [clusterId] 
                };
                selectItem.iconPath = new vscode.ThemeIcon('star');
                items.push(selectItem);
            }

            const disconnectItem = new ExplorerItem('Disconnect', 'disconnect', vscode.TreeItemCollapsibleState.None);
            disconnectItem.command = { 
                command: 'esExt.disconnectFromCluster', 
                title: 'Disconnect', 
                arguments: [clusterId] 
            };
            disconnectItem.iconPath = new vscode.ThemeIcon('debug-disconnect');
            items.push(disconnectItem);

            const removeItem = new ExplorerItem('Remove Cluster', 'remove', vscode.TreeItemCollapsibleState.None);
            removeItem.command = { 
                command: 'esExt.removeCluster', 
                title: 'Remove', 
                arguments: [clusterId] 
            };
            removeItem.iconPath = new vscode.ThemeIcon('trash');
            items.push(removeItem);

            return items;
        }

        // Handle cluster-specific content expansion
        if (element.contextValue?.includes(':')) {
            const [category, ...rest] = element.contextValue.split(':');
            const clusterId = rest[rest.length - 1];
            const client = this.clients.get(clusterId);
            
            if (!client) {
                return [new ExplorerItem('Not connected', undefined, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('error'))];
            }

            switch (category) {
                case 'clusterInfo':
                    return this.fetchClusterInfo(client, clusterId);
                case 'nodes':
                    return this.fetchClusterNodes(client);
                case 'links':
                    return this.fetchImportantLinks(clusterId);
                case 'elasticsearch':
                    return this.fetchElasticsearchLinks(clusterId);
                case 'kibana':
                    return this.fetchKibanaLinks(clusterId);
                case 'haproxy':
                    return this.fetchHAProxyLinks(clusterId);
                case 'dataStreams':
                    return this.fetchDataStreams(client, clusterId);
                case 'dataStream': {
                    const dataStreamName = rest.slice(0, -1).join(':');
                    return this.fetchDataStreamIndices(client, dataStreamName, clusterId);
                }
                case 'roles':
                    return this.fetchRoles(client);
                case 'roleMappings':
                    return this.fetchRoleMappings(client);
                case 'indexTemplates':
                    return this.fetchIndexTemplates(client);
                default:
                    return [];
            }
        }

        // Legacy support for old context values (should not be used anymore)
        const client = this.getActiveClient();
        if (!client) return [];

        switch (element.contextValue) {
            case 'dataStreams':
                return this.fetchDataStreams(client);
            case 'roles':
                return this.fetchRoles(client);
            case 'roleMappings':
                return this.fetchRoleMappings(client);
            case 'indexTemplates':
                return this.fetchIndexTemplates(client);
            case 'cluster':
                return this.fetchClusterInfo(client);
            default:
                return [];
        }
    }

    private async loadClusters(): Promise<void> {
        // Load cluster configs from storage
        const clusterIds = await this.context.globalState.get<string[]>('esExt.clusterIds', []);
        
        for (const id of clusterIds) {
            const configJson = await this.context.secrets.get(`esExt.cluster.${id}.config`);
            if (configJson) {
                try {
                    const config: ClusterConfig = JSON.parse(configJson);
                    this.clusters.set(id, config);
                } catch (err) {
                    console.error(`[ESExt] Failed to parse cluster config for ${id}:`, err);
                }
            }
        }

        // Set active cluster if we have any
        if (this.clusters.size > 0 && !this.activeClusterId) {
            this.activeClusterId = Array.from(this.clusters.keys())[0];
        }
    }

    private async saveClusterConfig(config: ClusterConfig): Promise<void> {
        // Save cluster config to secrets
        await this.context.secrets.store(`esExt.cluster.${config.id}.config`, JSON.stringify(config));
        
        // Update cluster IDs list
        const clusterIds = await this.context.globalState.get<string[]>('esExt.clusterIds', []);
        if (!clusterIds.includes(config.id)) {
            clusterIds.push(config.id);
            await this.context.globalState.update('esExt.clusterIds', clusterIds);
        }
    }

    async storeClusterCredentials(clusterId: string, authMethod: string, credentials: any): Promise<void> {
        if (authMethod === 'Basic: Username/Password') {
            await this.context.secrets.store(`esExt.cluster.${clusterId}.username`, credentials.username);
            await this.context.secrets.store(`esExt.cluster.${clusterId}.password`, credentials.password);
        } else if (authMethod === 'API Key') {
            await this.context.secrets.store(`esExt.cluster.${clusterId}.apiKey`, credentials.apiKey);
        }
    }

    // Connection state management for auto-reconnect
    private async saveConnectedCluster(clusterId: string): Promise<void> {
        const connectedClusters = await this.context.globalState.get<string[]>('esExt.connectedClusters', []);
        if (!connectedClusters.includes(clusterId)) {
            connectedClusters.push(clusterId);
            await this.context.globalState.update('esExt.connectedClusters', connectedClusters);
        }
    }

    private async removeConnectedCluster(clusterId: string): Promise<void> {
        const connectedClusters = await this.context.globalState.get<string[]>('esExt.connectedClusters', []);
        const updatedClusters = connectedClusters.filter(id => id !== clusterId);
        await this.context.globalState.update('esExt.connectedClusters', updatedClusters);
    }

    private async autoReconnectClusters(): Promise<void> {
        const connectedClusters = await this.context.globalState.get<string[]>('esExt.connectedClusters', []);
        
        if (connectedClusters.length === 0) {
            return;
        }

        // Show progress for auto-reconnection
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Auto-reconnecting clusters...',
            cancellable: false
        }, async (progress) => {
            let reconnectedCount = 0;
            let failedCount = 0;

            for (let i = 0; i < connectedClusters.length; i++) {
                const clusterId = connectedClusters[i];
                const config = this.clusters.get(clusterId);
                
                if (!config) {
                    // Cluster no longer exists, remove from connected list
                    await this.removeConnectedCluster(clusterId);
                    failedCount++;
                    continue;
                }

                progress.report({ 
                    increment: (i / connectedClusters.length) * 100,
                    message: `Reconnecting to ${config.name}...` 
                });

                try {
                    const success = await this.connectToClusterSilently(clusterId);
                    if (success) {
                        reconnectedCount++;
                    } else {
                        failedCount++;
                        await this.removeConnectedCluster(clusterId);
                    }
                } catch (error) {
                    console.error(`[ESExt] Auto-reconnect failed for ${config.name}:`, error);
                    failedCount++;
                    await this.removeConnectedCluster(clusterId);
                }
            }

            // Show summary if we had clusters to reconnect
            if (reconnectedCount > 0 || failedCount > 0) {
                let message = '';
                if (reconnectedCount > 0) {
                    message += `Auto-reconnected ${reconnectedCount} cluster(s).`;
                }
                if (failedCount > 0) {
                    if (message) message += ' ';
                    message += `${failedCount} cluster(s) failed to reconnect.`;
                }
                
                if (failedCount > 0) {
                    vscode.window.showWarningMessage(message);
                } else {
                    vscode.window.showInformationMessage(message);
                }
            }
        });
    }

    private async connectToClusterSilently(clusterId: string): Promise<boolean> {
        const config = this.clusters.get(clusterId);
        if (!config) {
            return false;
        }

        try {
            const clientOptions: any = {};
            
            if (config.deploymentType === 'Elastic Cloud') {
                clientOptions.cloud = { id: config.cloudId };
            } else {
                clientOptions.node = config.nodeUrl;
            }

            // Load auth from secrets
            if (config.authMethod === 'Basic: Username/Password') {
                const username = await this.context.secrets.get(`esExt.cluster.${clusterId}.username`);
                const password = await this.context.secrets.get(`esExt.cluster.${clusterId}.password`);
                if (username && password) {
                    clientOptions.auth = { username, password };
                }
            } else if (config.authMethod === 'API Key') {
                const apiKey = await this.context.secrets.get(`esExt.cluster.${clusterId}.apiKey`);
                if (apiKey) {
                    clientOptions.auth = { apiKey };
                }
            }

            if (config.disableSSL) {
                clientOptions.ssl = { rejectUnauthorized: false };
                process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
            }

            // Inject CA certificate if present
            const caCert = await this.context.globalState.get<string>('esExt.caCertificate');
            if (caCert) {
                clientOptions.tls = clientOptions.tls || {};
                clientOptions.tls.ca = Buffer.from(caCert, 'utf8');
            }

            const client = new Client(clientOptions);
            await client.ping();

            this.clients.set(clusterId, client);
            if (!this.activeClusterId) {
                this.activeClusterId = clusterId;
            }
            
            // Fetch initial health status for this cluster
            try {
                const healthResponse: any = await client.cluster.health();
                const health = healthResponse.body || healthResponse;
                
                this.clusterHealth.set(clusterId, {
                    status: health.status || 'unknown',
                    clusterName: health.cluster_name || 'Unknown',
                    numberOfNodes: health.number_of_nodes || 0,
                    numberOfDataNodes: health.number_of_data_nodes || 0,
                    activePrimaryShards: health.active_primary_shards || 0,
                    activeShards: health.active_shards || 0,
                    lastChecked: new Date()
                });
            } catch (healthError) {
                // Set unknown status on health check error
                this.clusterHealth.set(clusterId, {
                    status: 'unknown',
                    clusterName: 'Unknown',
                    numberOfNodes: 0,
                    numberOfDataNodes: 0,
                    activePrimaryShards: 0,
                    activeShards: 0,
                    lastChecked: new Date()
                });
            }
            
            return true;        } catch (err: any) {
            console.error(`[ESExt] Silent reconnect failed for cluster ${clusterId}:`, err);
            return false;
        }
    }

    async disconnectFromCluster(clusterId: string): Promise<void> {
        // Remove client connection
        this.clients.delete(clusterId);
        
        // Remove from connected clusters list
        await this.removeConnectedCluster(clusterId);
        
        // Clear health status
        this.clusterHealth.delete(clusterId);
        
        // If this was the active cluster, clear it
        if (this.activeClusterId === clusterId) {
            this.activeClusterId = undefined;
        }
        
        // Refresh the tree
        this.refresh();
        
        const cluster = this.clusters.get(clusterId);
        const clusterName = cluster ? cluster.name : 'Unknown';
        vscode.window.showInformationMessage(`Disconnected from ${clusterName}`);
    }

    private async fetchClusterInfo(client: Client, clusterId?: string): Promise<ExplorerItem[]> {
        try {
            const [info, healthResponse, nodesResponse] = await Promise.all([
                client.info(),
                client.cluster.health(),
                client.nodes.info()
            ]);
            const config = clusterId ? this.clusters.get(clusterId) : this.getActiveCluster();
            
            // Calculate node and shard information
            const health: any = healthResponse;
            const nodes: any = nodesResponse;
            const totalNodes = health.number_of_nodes || 0;
            const dataNodes = health.number_of_data_nodes || 0;
            const currentShards = health.active_shards || 0;
            const shardLimit = dataNodes * 1000;
            const shardPercentage = shardLimit > 0 ? ((currentShards / shardLimit) * 100) : 0;
            
            // Determine shard status color and icon
            let shardStatusIcon: vscode.ThemeIcon;
            if (shardPercentage <= 80) {
                shardStatusIcon = new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
            } else if (shardPercentage <= 90) {
                shardStatusIcon = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
            } else {
                shardStatusIcon = new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
            }
            const items = [
                new ExplorerItem(`Name: ${info.name}`, undefined, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('tag')),
                new ExplorerItem(`Version: ${info.version.number}`, undefined, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('versions')),
                new ExplorerItem(`Cluster UUID: ${info.cluster_uuid}`, undefined, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('key'))
            ];

            // Add cluster configuration info
            if (config) {
                items.push(
                    new ExplorerItem(`Type: ${config.deploymentType}`, undefined, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('server')),
                    new ExplorerItem(`Endpoint: ${config.nodeUrl || config.cloudId}`, undefined, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('link')),
                    new ExplorerItem(`Auth: ${config.authMethod}`, undefined, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('shield'))
                );
            }

            return items;
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to fetch cluster info: ${err}`);
            return [new ExplorerItem('Failed to load cluster info', undefined, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('error'))];
        }
    }

    private async fetchClusterNodes(client: Client): Promise<ExplorerItem[]> {
        try {
            // Query node stats with filter_path for relevant info
            const statsResponse: any = await client.nodes.stats({
                filter_path: [
                    'nodes.*.name',
                    'nodes.*.ip',
                    'nodes.*.roles',
                    'nodes.*.os.cpu.percent',
                    'nodes.*.jvm.mem.heap_used_percent',
                    'nodes.*.fs.total.total_in_bytes',
                    'nodes.*.fs.total.free_in_bytes'
                ]
            });
            const nodes = statsResponse.nodes || statsResponse.body?.nodes || {};
            const nodeItems: ExplorerItem[] = [];
            for (const [nodeId, nodeInfoRaw] of Object.entries(nodes)) {
                const nodeInfo = nodeInfoRaw as any;
                const name = nodeInfo.name || nodeId;
                const ip = nodeInfo.ip || 'N/A';
                const roles = Array.isArray(nodeInfo.roles) ? nodeInfo.roles.join(', ') : 'N/A';
                const cpu = typeof nodeInfo.os?.cpu?.percent === 'number' ? `${nodeInfo.os.cpu.percent}%` : 'N/A';
                const jvm = typeof nodeInfo.jvm?.mem?.heap_used_percent === 'number' ? `${nodeInfo.jvm.mem.heap_used_percent}%` : 'N/A';
                const totalBytes = nodeInfo.fs?.total?.total_in_bytes;
                const freeBytes = nodeInfo.fs?.total?.free_in_bytes;
                const totalDisk = totalBytes !== undefined ? this.formatBytes(totalBytes) : 'N/A';
                const freeDisk = freeBytes !== undefined ? this.formatBytes(freeBytes) : 'N/A';
                // Compose label
                const label = `${name} (${ip})`;
                // Compose tooltip
                const tooltip = `Node ID: ${nodeId}\nRoles: ${roles}\nCPU: ${cpu}\nJVM Heap Used: ${jvm}\nDisk: ${freeDisk} free / ${totalDisk} total`;
                // Icon: use a different icon for master/data/ingest roles if possible
                let icon = new vscode.ThemeIcon('server');
                if (Array.isArray(nodeInfo.roles)) {
                    if (nodeInfo.roles.includes('master')) icon = new vscode.ThemeIcon('star');
                    else if (nodeInfo.roles.includes('data')) icon = new vscode.ThemeIcon('database');
                    else if (nodeInfo.roles.includes('ingest')) icon = new vscode.ThemeIcon('cloud-upload');
                }
                const item = new ExplorerItem(label, undefined, vscode.TreeItemCollapsibleState.None, icon);
                item.tooltip = tooltip;
                nodeItems.push(item);
            }
            if (nodeItems.length === 0) {
                return [new ExplorerItem('No nodes found', undefined, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('error'))];
            }
            return nodeItems;
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to fetch nodes: ${err}`);
            return [new ExplorerItem('Failed to load nodes', undefined, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('error'))];
        }
    }

    // Utility to format bytes as human-readable string
    private formatBytes(bytes: number): string {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    private async fetchDataStreams(client: Client, clusterId?: string): Promise<ExplorerItem[]> {
        try {
            // Get all data streams
            const dsResp = await client.indices.getDataStream();
            const dataStreams = dsResp.data_streams || [];
            // Get stats for all data streams
            const statsResp = await client.transport.request({
                method: 'GET',
                path: '/_data_stream/_stats',
                querystring: {
                    filter_path: '_all.total.docs.count,_all.total.docs.total_size_in_bytes,_all.total.shard_stats.total_count,data_streams.indices,status,health'
                }
            });
            const statsAny = statsResp as any;
            const stats = statsAny.data_streams || statsAny.body?.data_streams || [];
            // Map stats by data stream name
            const statsByName: Record<string, any> = {};
            for (const s of stats) {
                if (s.data_stream) statsByName[s.data_stream] = s;
            }
            // Compose tree items
            return dataStreams.sort((a: any, b: any) => a.name.localeCompare(b.name)).map((ds: any) => {
                const dsStats = statsByName[ds.name] || {};
                // Use sum from map if available
                const key = `${ds.name}:${clusterId}`;
                let docCount = 0;
                let sizeBytes = 0;
                if (this.dataStreamStatsSums.has(key)) {
                    const sum = this.dataStreamStatsSums.get(key)!;
                    docCount = sum.docCount as number;
                    sizeBytes = sum.sizeBytes as number;
                } else {
                    // Fallback: sum from backing_indices if available (may be 0)
                    if (Array.isArray(dsStats.backing_indices)) {
                        for (const idx of dsStats.backing_indices) {
                            let docs = idx?.stats?.primaries?.docs?.count;
                            let bytes = idx?.stats?.primaries?.store?.size_in_bytes;
                            if (docs === undefined) docs = idx?.doc_count;
                            if (bytes === undefined) bytes = idx?.store_size_bytes;
                            if (docs === undefined) docs = 0;
                            if (bytes === undefined) bytes = 0;
                            docCount += docs;
                            sizeBytes += bytes;
                        }
                    }
                }
                const label = `${ds.name} (${docCount} docs, ${this.formatBytes(sizeBytes)})`;
                const item = new ExplorerItem(label, `dataStream:${ds.name}:${clusterId}`, vscode.TreeItemCollapsibleState.Collapsed, new vscode.ThemeIcon('database'));
                item.command = {
                    command: 'esExt.showDataStreamStats',
                    title: 'Show Data Stream Stats',
                    arguments: [ds.name, clusterId]
                };
                return item;
            });
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to fetch Data Streams: ${err}`);
            return [new ExplorerItem('Failed to load data streams', undefined, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('error'))];
        }
    }

    private async fetchDataStreamIndices(client: Client, dataStreamName: string, clusterId?: string): Promise<ExplorerItem[]> {
        try {
            // Get data stream info
            const dsResp = await client.indices.getDataStream({ name: dataStreamName });
            const ds = dsResp.data_streams?.[0];
            if (!ds) return [new ExplorerItem('No indices found', undefined, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('error'))];
            // Get stats for this data stream
            const statsResp = await client.transport.request({
                method: 'GET',
                path: `/_data_stream/${encodeURIComponent(dataStreamName)}/_stats`,
                querystring: {
                    filter_path: 'data_streams.indices,status,health'
                }
            });
            const statsAny = statsResp as any;
            const dsStats = (statsAny.data_streams || statsAny.body?.data_streams || [])[0] || {};
            const indices = dsStats.indices || ds.indices || [];
            // Compose index items and sum
            const items: ExplorerItem[] = [];
            let totalDocs: number = 0;
            let totalBytes: number = 0;
            for (const idx of indices) {
                const idxName = idx.index_name || idx.name || idx;
                let docCount = idx?.stats?.primaries?.docs?.count;
                let sizeBytes = idx?.stats?.primaries?.store?.size_in_bytes;
                if (docCount === undefined) docCount = idx?.doc_count;
                if (sizeBytes === undefined) sizeBytes = idx?.store_size_bytes;
                if (!docCount && !sizeBytes) {
                    try {
                        const statsResp = await client.indices.stats({ index: idxName });
                        const stats = (statsResp as any).body || statsResp;
                        const primaries = stats.indices?.[idxName]?.primaries;
                        docCount = primaries?.docs?.count ?? 0;
                        sizeBytes = primaries?.store?.size_in_bytes ?? 0;
                    } catch {
                        docCount = 0;
                        sizeBytes = 0;
                    }
                }
                totalDocs += typeof docCount === 'number' ? docCount : 0;
                totalBytes += typeof sizeBytes === 'number' ? sizeBytes : 0;
                let icon = new vscode.ThemeIcon('database');
                const health = idx?.health || 'unknown';
                if (health === 'green') icon = new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
                else if (health === 'yellow') icon = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
                else if (health === 'red') icon = new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
                const label = `${idxName} (${docCount} docs, ${typeof sizeBytes === 'number' ? this.formatBytes(sizeBytes) : sizeBytes})`;
                const item = new ExplorerItem(label, `dataStreamIndex:${dataStreamName}:${idxName}:${clusterId}`, vscode.TreeItemCollapsibleState.None, icon);
                item.command = {
                    command: 'esExt.showDataStreamIndexStats',
                    title: 'Show Data Stream Index Stats',
                    arguments: [dataStreamName, idxName, clusterId]
                };
                items.push(item);
            }
            // Store the sum for the parent and refresh only the parent node
            const key = `${dataStreamName}:${clusterId}`;
            this.dataStreamStatsSums.set(key, { docCount: totalDocs, sizeBytes: totalBytes });
            // Find the parent ExplorerItem for this data stream (by contextValue)
            const parentItem = new ExplorerItem(
                `${dataStreamName} (${totalDocs} docs, ${this.formatBytes(totalBytes)})`,
                `dataStream:${dataStreamName}:${clusterId}`,
                vscode.TreeItemCollapsibleState.Collapsed,
                new vscode.ThemeIcon('database')
            );
            this._onDidChangeTreeData.fire(parentItem);
            return items;
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to fetch indices for data stream ${dataStreamName}: ${err}`);
            return [new ExplorerItem('Failed to load indices', undefined, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('error'))];
        }
    }

    private fetchImportantLinks(clusterId: string): ExplorerItem[] {
        const config = this.clusters.get(clusterId);
        if (!config) {
            return [new ExplorerItem('Cluster not found', undefined, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('error'))];
        }

        // Determine domain based on cluster name
        const isProd = config.name.toUpperCase().includes('PROD');
        const domain = isProd ? 'wtg.zone' : 'sand.wtg.zone';
        const clusterName = config.name.toLowerCase();

        // Extract base URL from nodeUrl if available
        let elasticUrl = '';
        if (config.nodeUrl) {
            try {
                const url = new URL(config.nodeUrl);
                elasticUrl = `${url.protocol}//${url.host}`;
            } catch {
                elasticUrl = config.nodeUrl;
            }
        }

        const items: ExplorerItem[] = [];

        // Elasticsearch section
        const elasticsearchSection = new ExplorerItem('Elasticsearch', `elasticsearch:${clusterId}`, vscode.TreeItemCollapsibleState.Collapsed, new vscode.ThemeIcon('database'));
        items.push(elasticsearchSection);

        // Kibana section
        const kibanaSection = new ExplorerItem('Kibana', `kibana:${clusterId}`, vscode.TreeItemCollapsibleState.Collapsed, new vscode.ThemeIcon('graph'));
        items.push(kibanaSection);

        // HAProxy section
        const haproxySection = new ExplorerItem('HAProxy', `haproxy:${clusterId}`, vscode.TreeItemCollapsibleState.Collapsed, new vscode.ThemeIcon('server-process'));
        items.push(haproxySection);

        return items;
    }

    private fetchElasticsearchLinks(clusterId: string): ExplorerItem[] {
        const config = this.clusters.get(clusterId);
        if (!config) {
            return [new ExplorerItem('Cluster not found', undefined, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('error'))];
        }

        // Extract base URL from nodeUrl if available
        let elasticUrl = '';
        if (config.nodeUrl) {
            try {
                const url = new URL(config.nodeUrl);
                elasticUrl = `${url.protocol}//${url.host}`;
            } catch {
                elasticUrl = config.nodeUrl;
            }
        }

        const items: ExplorerItem[] = [];

        // Cluster Health link
        const healthLink = new ExplorerItem('GET _cluster/health', undefined, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('heart'));
        healthLink.command = {
            command: 'vscode.open',
            title: 'Open Cluster Health',
            arguments: [vscode.Uri.parse(`${elasticUrl}/_cluster/health`)]
        };
        healthLink.tooltip = `${elasticUrl}/_cluster/health`;
        items.push(healthLink);

        // Cluster Settings link
        const settingsLink = new ExplorerItem('GET _cluster/settings', undefined, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('settings-gear'));
        settingsLink.command = {
            command: 'vscode.open',
            title: 'Open Cluster Settings',
            arguments: [vscode.Uri.parse(`${elasticUrl}/_cluster/settings`)]
        };
        settingsLink.tooltip = `${elasticUrl}/_cluster/settings`;
        items.push(settingsLink);

        return items;
    }

    private fetchKibanaLinks(clusterId: string): ExplorerItem[] {
        const config = this.clusters.get(clusterId);
        if (!config) {
            return [new ExplorerItem('Cluster not found', undefined, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('error'))];
        }

        // Determine domain based on cluster name
        const isProd = config.name.toUpperCase().includes('PROD');
        const domain = isProd ? 'wtg.zone' : 'sand.wtg.zone';
        const clusterName = config.name.toLowerCase();

        const items: ExplorerItem[] = [];

        // API Status link
        const statusLink = new ExplorerItem('GET /api/status', undefined, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('pulse'));
        statusLink.command = {
            command: 'vscode.open',
            title: 'Open Kibana Status',
            arguments: [vscode.Uri.parse(`https://kibana.${clusterName}.${domain}/api/status`)]
        };
        statusLink.tooltip = `kibana.${clusterName}.${domain}/api/status`;
        items.push(statusLink);

        // Dev Console link
        const devConsoleLink = new ExplorerItem('Dev Console', undefined, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('terminal'));
        devConsoleLink.command = {
            command: 'vscode.open',
            title: 'Open Dev Console',
            arguments: [vscode.Uri.parse(`https://kibana.${clusterName}.${domain}/app/dev_tools#/console`)]
        };
        devConsoleLink.tooltip = `kibana.${clusterName}.${domain}/app/dev_tools#/console`;
        items.push(devConsoleLink);

        // Stack Monitoring link
        const monitoringLink = new ExplorerItem('Stack Monitoring', undefined, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('graph-line'));
        monitoringLink.command = {
            command: 'vscode.open',
            title: 'Open Stack Monitoring',
            arguments: [vscode.Uri.parse(`https://kibana.${clusterName}.${domain}/app/monitoring#/overview`)]
        };
        monitoringLink.tooltip = `kibana.${clusterName}.${domain}/app/monitoring#/overview`;
        items.push(monitoringLink);

        return items;
    }

    private fetchHAProxyLinks(clusterId: string): ExplorerItem[] {
        const config = this.clusters.get(clusterId);
        if (!config) {
            return [new ExplorerItem('Cluster not found', undefined, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('error'))];
        }

        // Determine domain based on cluster name
        const isProd = config.name.toUpperCase().includes('PROD');
        const domain = isProd ? 'wtg.zone' : 'sand.wtg.zone';
        const clusterName = config.name.toLowerCase();

        const items: ExplorerItem[] = [];

        // Stats Page link
        const statsLink = new ExplorerItem('Stats Page', undefined, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('graph'));
        statsLink.command = {
            command: 'vscode.open',
            title: 'Open HAProxy Stats',
            arguments: [vscode.Uri.parse(`https://haproxy.${clusterName}.${domain}`)]
        };
        statsLink.tooltip = `haproxy.${clusterName}.${domain}`;
        items.push(statsLink);

        return items;
    }

    private async fetchRoles(client: Client): Promise<ExplorerItem[]> {
        try {
            const roles = await client.security.getRole();
            return Object.keys(roles)
                .sort((a, b) => a.localeCompare(b))
                .map(name => {
                    const item = new ExplorerItem(name, undefined, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('person'));
                    item.command = {
                        command: 'esExt.showRole',
                        title: 'View Role',
                        arguments: [name]
                    };
                    return item;
                });
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to fetch Roles: ${err}`);
            return [new ExplorerItem('Failed to load roles', undefined, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('error'))];
        }
    }

    private async fetchRoleMappings(client: Client): Promise<ExplorerItem[]> {
        try {
            const roleMappings = await client.security.getRoleMapping();
            return Object.keys(roleMappings)
                .sort((a, b) => a.localeCompare(b))
                .map(name => {
                    const item = new ExplorerItem(name, undefined, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('organization'));
                    item.command = {
                        command: 'esExt.showRoleMapping',
                        title: 'View Role Mapping',
                        arguments: [name]
                    };
                    return item;
                });
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to fetch Role Mappings: ${err}`);
            return [new ExplorerItem('Failed to load role mappings', undefined, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('error'))];
        }
    }

    private async fetchIndexTemplates(client: Client): Promise<ExplorerItem[]> {
        try {
            const response = await client.indices.getIndexTemplate(); // Fetches composable index templates
            const body = (response as any).body || response;
            if (body && Array.isArray(body.index_templates)) {
                return body.index_templates
                    .map((templateInfo: any) => { // templateInfo contains name and the template definition
                        const treeItem = new ExplorerItem(templateInfo.name, `indexTemplateItem:${templateInfo.name}`, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('file-code'));
                        treeItem.command = {
                            command: 'esExt.showIndexTemplate',
                            title: 'View Index Template',
                            arguments: [templateInfo.name]
                        };
                        return treeItem;
                    })
                    .sort((a: ExplorerItem, b: ExplorerItem) => a.label.localeCompare(b.label as string)); // Sort by label
            } else {
                // Handle cases where index_templates is not an array or response.body is not as expected
                console.warn('[ESExt] No index templates found or unexpected response format from client.indices.getIndexTemplate()');
                vscode.window.showInformationMessage('No index templates found.');
                return [];
            }
        } catch (err: any) {
            console.error('[ESExt] Error fetching index templates:', err);
            vscode.window.showErrorMessage(`Failed to fetch Index Templates: ${err.message}`);
            return [new ExplorerItem('Failed to load index templates', undefined, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('error'))];
        }
    }

    async exportClusters(): Promise<void> {
        if (this.clusters.size === 0) {
            vscode.window.showInformationMessage('No clusters to export.');
            return;
        }

        try {
            // Create export data without sensitive information
            const exportData: ClusterExportFile = {
                version: '1.0.0',
                exportDate: new Date().toISOString(),
                clusters: Array.from(this.clusters.values()).map(cluster => ({
                    name: cluster.name,
                    deploymentType: cluster.deploymentType,
                    nodeUrl: cluster.nodeUrl,
                    cloudId: cluster.cloudId,
                    authMethod: cluster.authMethod,
                    disableSSL: cluster.disableSSL
                }))
            };

            // Show save dialog
            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(`elasticsearch-clusters-${new Date().toISOString().split('T')[0]}.json`),
                filters: {
                    'JSON Files': ['json'],
                    'All Files': ['*']
                },
                saveLabel: 'Export Clusters'
            });

            if (saveUri) {
                await vscode.workspace.fs.writeFile(saveUri, Buffer.from(JSON.stringify(exportData, null, 2)));
                vscode.window.showInformationMessage(`Successfully exported ${exportData.clusters.length} cluster configuration(s) to ${saveUri.fsPath}`);
            }
        } catch (error) {
            console.error('[ESExt] Failed to export clusters:', error);
            vscode.window.showErrorMessage(`Failed to export clusters: ${error}`);
        }
    }

    async importClusters(): Promise<void> {
        try {
            // Show open dialog
            const openUri = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: {
                    'JSON Files': ['json'],
                    'All Files': ['*']
                },
                openLabel: 'Import Clusters'
            });

            if (!openUri || openUri.length === 0) {
                return;
            }

            // Read the file
            const fileContent = await vscode.workspace.fs.readFile(openUri[0]);
            const importData: ClusterExportFile = JSON.parse(fileContent.toString());

            // Validate the import data
            if (!importData.clusters || !Array.isArray(importData.clusters)) {
                vscode.window.showErrorMessage('Invalid cluster configuration file format.');
                return;
            }

            let importedCount = 0;
            let skippedCount = 0;

            for (const clusterData of importData.clusters) {
                // Validate required fields
                if (!clusterData.name || !clusterData.deploymentType || !clusterData.authMethod) {
                    console.warn('[ESExt] Skipping invalid cluster:', clusterData);
                    skippedCount++;
                    continue;
                }

                // Check if cluster with same name already exists
                const existingCluster = Array.from(this.clusters.values()).find(c => c.name === clusterData.name);
                if (existingCluster) {
                    const overwrite = await vscode.window.showWarningMessage(
                        `Cluster "${clusterData.name}" already exists. Do you want to overwrite it?`,
                        'Yes', 'No', 'Cancel'
                    );

                    if (overwrite === 'Cancel') {
                        break;
                    } else if (overwrite === 'No') {
                        skippedCount++;
                        continue;
                    } else {
                        // Remove existing cluster
                        await this.removeCluster(existingCluster.id);
                    }
                }

                // Create new cluster config
                const newClusterConfig: ClusterConfig = {
                    id: this.generateClusterId(),
                    name: clusterData.name,
                    deploymentType: clusterData.deploymentType,
                    nodeUrl: clusterData.nodeUrl,
                    cloudId: clusterData.cloudId,
                    authMethod: clusterData.authMethod,
                    disableSSL: clusterData.disableSSL
                };

                // Add the cluster
                await this.addCluster(newClusterConfig);
                importedCount++;
            }

            // Show summary
            let message = `Successfully imported ${importedCount} cluster(s).`;
            if (skippedCount > 0) {
                message += ` ${skippedCount} cluster(s) were skipped.`;
            }
            
            if (importedCount > 0) {
                message += '\n\nNote: You will need to configure authentication credentials for the imported clusters.';
            }

            vscode.window.showInformationMessage(message);

        } catch (error) {
            console.error('[ESExt] Failed to import clusters:', error);
            vscode.window.showErrorMessage(`Failed to import clusters: ${error}`);
        }
    }    private generateClusterId(): string {
        return `cluster_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
}

// Tree item class
export class ExplorerItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly contextValue?: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.Collapsed,
        iconPath?: vscode.ThemeIcon | vscode.Uri | { light: vscode.Uri; dark: vscode.Uri }
    ) {
        super(label, collapsibleState);
        if (contextValue) {
            this.contextValue = contextValue;
        }
        if (iconPath) {
            this.iconPath = iconPath;
        }
    }
}
