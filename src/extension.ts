import * as vscode from 'vscode';
import { Client } from '@elastic/elasticsearch';
import { ESExplorerProvider } from './tree/ESExplorerProvider';

export function activate(context: vscode.ExtensionContext) {
    const explorerProvider = new ESExplorerProvider(context);
    vscode.window.registerTreeDataProvider('esExtExplorer', explorerProvider);

    // Load saved clusters on startup
    explorerProvider.loadClustersOnStartup();

    context.subscriptions.push(
        vscode.commands.registerCommand('esExt.addCluster', async () => {
            const clusterId = `cluster-${Date.now()}`;
            
            // Gather cluster configuration
            const name = await vscode.window.showInputBox({ 
                prompt: 'Cluster Name',
                placeHolder: 'e.g. Production Cluster'
            });
            if (!name) return;

            const deploymentType = await vscode.window.showQuickPick(
                ['Self-managed Cluster', 'Elastic Cloud'],
                { placeHolder: 'Select Elasticsearch deployment type' }
            );
            if (!deploymentType) return;

            let clientOptions: any = {};
            let nodeUrl: string | undefined;
            let cloudId: string | undefined;

            if (deploymentType === 'Elastic Cloud') {
                cloudId = await vscode.window.showInputBox({ 
                    prompt: 'Elastic Cloud ID',
                    placeHolder: 'e.g. myDeployment:abcdef..'
                });
                if (!cloudId) return;
                clientOptions.cloud = { id: cloudId };
            } else {
                nodeUrl = await vscode.window.showInputBox({
                    prompt: 'Full Elasticsearch URL (include protocol and port)',
                    placeHolder: 'e.g. http://elasticsearch.apac-test-1.sand.wtg.zone:9200 or https://host:9243'
                });
                if (!nodeUrl) return;
                clientOptions.node = nodeUrl;
            }

            // Authentication
            const authMethod = await vscode.window.showQuickPick(
                ['None', 'Basic: Username/Password', 'API Key'],
                { placeHolder: 'Select auth method' }
            );
            if (!authMethod) return;

            let credentials: any = {};
            if (authMethod === 'Basic: Username/Password') {
                const username = await vscode.window.showInputBox({ prompt: 'Username' });
                const password = username ? await vscode.window.showInputBox({ prompt: 'Password', password: true }) : undefined;
                if (username && password) {
                    clientOptions.auth = { username, password };
                    credentials = { username, password };
                }
            } else if (authMethod === 'API Key') {
                const apiKey = await vscode.window.showInputBox({ prompt: 'API Key' });
                if (apiKey) {
                    clientOptions.auth = { apiKey };
                    credentials = { apiKey };
                }
            }

            // SSL options
            const disableSSL = await vscode.window.showQuickPick(
                ['Yes', 'No'],
                { placeHolder: 'Disable SSL certificate verification? (insecure)' }
            );
            
            if (disableSSL === 'Yes') {
                clientOptions.ssl = { rejectUnauthorized: false };
                process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
            }

            // Test connection
            try {
                const tempClient = new Client(clientOptions);
                await tempClient.ping();
                
                // Save cluster configuration
                const config = {
                    id: clusterId,
                    name,
                    deploymentType,
                    nodeUrl,
                    cloudId,
                    authMethod,
                    disableSSL: disableSSL === 'Yes'
                };

                await explorerProvider.addCluster(config);
                await explorerProvider.storeClusterCredentials(clusterId, authMethod, credentials);
                await explorerProvider.connectToCluster(clusterId);

                vscode.window.showInformationMessage(`Successfully added and connected to cluster: ${name}`);
                explorerProvider.refresh();
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to connect to cluster: ${err.message}`);
            }
        }),

        vscode.commands.registerCommand('esExt.selectCluster', async (clusterId: string) => {
            explorerProvider.setActiveCluster(clusterId);
            const success = await explorerProvider.connectToCluster(clusterId);
            if (success) {
                const cluster = explorerProvider.getActiveCluster();
                vscode.window.showInformationMessage(`Connected to ${cluster?.name}`);
            } else {
                vscode.window.showErrorMessage('Failed to connect to cluster');
            }
        }),

        vscode.commands.registerCommand('esExt.connectToCluster', async (clusterId: string) => {
            const success = await explorerProvider.connectToCluster(clusterId);
            if (success) {
                const cluster = explorerProvider.getActiveCluster();
                vscode.window.showInformationMessage(`Connected to ${cluster?.name}`);
                explorerProvider.refresh();
            } else {
                vscode.window.showErrorMessage('Failed to connect to cluster');
            }
        }),        vscode.commands.registerCommand('esExt.removeCluster', async (clusterId: string) => {
            const cluster = explorerProvider.getCluster(clusterId);
            if (!cluster) return;

            const confirm = await vscode.window.showWarningMessage(
                `Remove cluster "${cluster.name}"?`,
                { modal: true },
                'Remove'
            );
            
            if (confirm === 'Remove') {
                await explorerProvider.removeCluster(clusterId);
                vscode.window.showInformationMessage(`Removed cluster: ${cluster.name}`);
            }
        }),

        vscode.commands.registerCommand('esExt.search', async () => {
            const client = explorerProvider.getActiveClient();
            if (!client) {
                vscode.window.showErrorMessage('Please connect to an Elasticsearch cluster first.');
                return;
            }
            
            const index = await vscode.window.showInputBox({ prompt: 'Index to search', placeHolder: '_all' });
            const query = await vscode.window.showInputBox({ prompt: 'Query as JSON', value: '{"query":{"match_all":{}}}' });
            if (!query) return;
              try {
                const searchResult = await client.search({
                    index: index && index.length > 0 ? index : undefined,
                    body: JSON.parse(query)
                });
                const doc = await vscode.workspace.openTextDocument({ content: JSON.stringify(searchResult, null, 2), language: 'json' });
                await vscode.window.showTextDocument(doc, { preview: false });
            } catch (err: any) {
                vscode.window.showErrorMessage(`Search error: ${err.message}`);
            }
        }),

        vscode.commands.registerCommand('esExt.openKibana', () => {
            const kibanaUrl = context.globalState.get<string>('esExt.kibanaUrl');
            if (kibanaUrl) {
                vscode.env.openExternal(vscode.Uri.parse(kibanaUrl));
            } else {
                vscode.window.showErrorMessage('Kibana URL not set. Add it when creating a cluster.');
            }        }),        vscode.commands.registerCommand('esExt.clusterHealth', async () => {
            const client = explorerProvider.getActiveClient();
            if (!client) {
                vscode.window.showErrorMessage('Please connect to an Elasticsearch cluster first.');
                return;
            }
            
            try {
                const healthResult = await client.cluster.health();
                const doc = await vscode.workspace.openTextDocument({ 
                    content: JSON.stringify(healthResult, null, 2), 
                    language: 'json' 
                });
                await vscode.window.showTextDocument(doc, { preview: false });
            } catch (err: any) {
                vscode.window.showErrorMessage(`Cluster health error: ${err.message}`);
            }
        }),

        vscode.commands.registerCommand('esExt.toggleAutoRefresh', () => {
            explorerProvider.toggleAutoRefresh();
        }),

        vscode.commands.registerCommand('esExt.refresh', () => explorerProvider.refresh())
    );

    // Register context menu commands for cluster items
    vscode.commands.registerCommand('esExt.clusterContextMenu', async (item) => {
        if (item.contextValue?.startsWith('clusterItem:')) {
            const clusterId = item.contextValue.split(':')[1];
            const action = await vscode.window.showQuickPick(
                ['Connect', 'Remove', 'Edit'],
                { placeHolder: 'Select action' }
            );
            
            switch (action) {
                case 'Connect':
                    vscode.commands.executeCommand('esExt.connectToCluster', clusterId);
                    break;
                case 'Remove':
                    vscode.commands.executeCommand('esExt.removeCluster', clusterId);
                    break;
                case 'Edit':
                    vscode.window.showInformationMessage('Edit cluster functionality coming soon!');
                    break;
            }
        }
    });
}

export function deactivate() {
    // Clean up any timers or resources
}
