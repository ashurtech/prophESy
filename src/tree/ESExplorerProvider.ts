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
    private refreshTimer: NodeJS.Timeout | undefined;    constructor(context: vscode.ExtensionContext) {
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
        await this.context.secrets.delete(`esExt.cluster.${clusterId}.config`);
        await this.context.secrets.delete(`esExt.cluster.${clusterId}.username`);
        await this.context.secrets.delete(`esExt.cluster.${clusterId}.password`);
        await this.context.secrets.delete(`esExt.cluster.${clusterId}.apiKey`);
          if (this.activeClusterId === clusterId) {
            this.activeClusterId = this.clusters.size > 0 ? Array.from(this.clusters.keys())[0] : undefined;
        }
        this.refresh();
    }    toggleAutoRefresh(): void {
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
    }    private async refreshClusterHealth(): Promise<void> {
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
    }    getAutoRefreshStatus(): boolean {
        return this.autoRefreshEnabled;
    }

    dispose(): void {
        this.stopAutoRefresh();
    }async connectToCluster(clusterId: string): Promise<boolean> {
        const config = this.clusters.get(clusterId);
        if (!config) {
            vscode.window.showErrorMessage(`Cluster ${clusterId} not found`);
            return false;
        }

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

                progress.report({ increment: 30, message: 'Testing connection...' });
                const client = new Client(clientOptions);
                await client.ping();                this.clients.set(clusterId, client);
                this.activeClusterId = clusterId;
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
        return element;
    }    async getChildren(element?: ExplorerItem): Promise<ExplorerItem[]> {
        if (!element) {
            // Root level - show all clusters with their data
            const items: ExplorerItem[] = [];
            
            // If no clusters, show add button
            if (this.clusters.size === 0) {
                const addClusterItem = new ExplorerItem('Add Elasticsearch Cluster', 'addCluster', vscode.TreeItemCollapsibleState.None);
                addClusterItem.command = { command: 'esExt.addCluster', title: 'Add Cluster' };
                addClusterItem.iconPath = new vscode.ThemeIcon('add');
                return [addClusterItem];
            }            // Show each cluster as a top-level expandable item
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
                
                const label = `${config.name}${statusText}${healthText}`;
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
            }            // Show cluster data categories if connected
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

            const removeItem = new ExplorerItem('Remove Cluster', 'remove', vscode.TreeItemCollapsibleState.None);
            removeItem.command = { 
                command: 'esExt.removeCluster', 
                title: 'Remove', 
                arguments: [clusterId] 
            };
            removeItem.iconPath = new vscode.ThemeIcon('trash');
            items.push(removeItem);

            return items;
        }        // Handle cluster-specific content expansion
        if (element.contextValue?.includes(':')) {
            const [category, clusterId] = element.contextValue.split(':');
            const client = this.clients.get(clusterId);
            
            if (!client) {
                return [new ExplorerItem('Not connected', undefined, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('error'))];
            }

            switch (category) {
                case 'clusterInfo':
                    return this.fetchClusterInfo(client, clusterId);
                case 'dataStreams':
                    return this.fetchDataStreams(client);
                case 'roles':
                    return this.fetchRoles(client);
                case 'roleMappings':
                    return this.fetchRoleMappings(client);
                case 'indexTemplates':
                    return this.fetchIndexTemplates(client);
                default:
                    return [];
            }
        }        // Legacy support for old context values (should not be used anymore)
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
    }    private async fetchClusterInfo(client: Client, clusterId?: string): Promise<ExplorerItem[]> {
        try {
            const info = await client.info();
            const config = clusterId ? this.clusters.get(clusterId) : this.getActiveCluster();
            
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
    }    private async fetchDataStreams(client: Client): Promise<ExplorerItem[]> {
        try {
            const dataStreams = await client.indices.getDataStream();
            const dataStreamNames = dataStreams.data_streams?.map((ds: any) => ds.name) || [];
            return dataStreamNames
                .sort((a, b) => a.localeCompare(b))
                .map((name: string) => 
                    new ExplorerItem(name, undefined, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('database'))
                );
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to fetch Data Streams: ${err}`);
            return [new ExplorerItem('Failed to load data streams', undefined, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('error'))];
        }
    }    private async fetchRoles(client: Client): Promise<ExplorerItem[]> {
        try {
            const roles = await client.security.getRole();
            return Object.keys(roles)
                .sort((a, b) => a.localeCompare(b))
                .map(name => 
                    new ExplorerItem(name, undefined, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('person'))
                );
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to fetch Roles: ${err}`);
            return [new ExplorerItem('Failed to load roles', undefined, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('error'))];
        }
    }    private async fetchRoleMappings(client: Client): Promise<ExplorerItem[]> {
        try {
            const roleMappings = await client.security.getRoleMapping();
            return Object.keys(roleMappings)
                .sort((a, b) => a.localeCompare(b))
                .map(name => 
                    new ExplorerItem(name, undefined, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('organization'))
                );
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to fetch Role Mappings: ${err}`);
            return [new ExplorerItem('Failed to load role mappings', undefined, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('error'))];
        }
    }    private async fetchIndexTemplates(client: Client): Promise<ExplorerItem[]> {
        try {
            const templates = await client.indices.getIndexTemplate();
            return templates.index_templates
                .map((t: any) => t.name)
                .sort((a, b) => a.localeCompare(b))
                .map((name: string) => 
                    new ExplorerItem(name, undefined, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('file-code'))
                );
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to fetch Index Templates: ${err}`);            return [new ExplorerItem('Failed to load index templates', undefined, vscode.TreeItemCollapsibleState.None, new vscode.ThemeIcon('error'))];
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
    }

    private generateClusterId(): string {
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
