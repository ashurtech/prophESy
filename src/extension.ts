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

        vscode.commands.registerCommand('esExt.refresh', () => explorerProvider.refresh()),

        vscode.commands.registerCommand('esExt.exportClusters', async () => {
            try {
                await explorerProvider.exportClusters();
            } catch (err: any) {
                vscode.window.showErrorMessage(`Export failed: ${err.message}`);
            }
        }),        vscode.commands.registerCommand('esExt.importClusters', async () => {
            try {
                await explorerProvider.importClusters();
            } catch (err: any) {
                vscode.window.showErrorMessage(`Import failed: ${err.message}`);
            }
        }),

        vscode.commands.registerCommand('esExt.showIndexTemplate', async (templateName: string) => {
            // If called from the tree, templateName should be provided. If not, prompt for it.
            if (!templateName) {
                const inputName = await vscode.window.showInputBox({
                    prompt: 'Enter Index Template Name',
                    placeHolder: 'e.g. my_template'
                });
                if (!inputName) {
                    vscode.window.showInformationMessage('No index template name provided.');
                    return;
                }
                templateName = inputName;
            }

            let client = explorerProvider.getActiveClient();
            if (!client) {
                console.warn('[esExt.showIndexTemplate] No active Elasticsearch client found.');
                vscode.window.showErrorMessage('Please connect to an Elasticsearch cluster first.');
                return;
            }

            try {
                // Use getIndexTemplate to fetch composable template definitions,
                // consistent with how they are listed.
                const response = await client.indices.getIndexTemplate({ name: templateName });

                // Fix: Cast response to any to access .body
                const templates = (response as any).body?.index_templates || (response as any).index_templates;
                const templateInfo = templates?.find((t: any) => t.name === templateName);

                const templateDefinition = templateInfo?.index_template;

                if (templateDefinition) {
                    const prettyJson = JSON.stringify(templateDefinition, null, 2);
                    const doc = await vscode.workspace.openTextDocument({
                        content: prettyJson,
                        language: 'json'
                    });
                    await vscode.window.showTextDocument(doc, { preview: false });
                } else {
                    vscode.window.showErrorMessage(`Index template "${templateName}" definition not found. It might not exist, the name is incorrect, or it's not a composable template.`);
                }
            } catch (err: any) {
                if (err.meta && err.meta.statusCode === 404) {
                    vscode.window.showErrorMessage(`Index template "${templateName}" not found (404).`);
                } else {
                    vscode.window.showErrorMessage(`Failed to fetch index template "${templateName}": ${err.message}`);
                }
            }
        }),

        vscode.commands.registerCommand('esExt.disconnectFromCluster', async (clusterId: string) => {
            const cluster = explorerProvider.getCluster(clusterId);
            if (!cluster) return;

            await explorerProvider.disconnectFromCluster(clusterId);
        }),

        vscode.commands.registerCommand('esExt.clearAllClusterData', async () => {
            const confirm = await vscode.window.showWarningMessage(
                'This will remove ALL saved clusters and credentials from VS Code. Are you sure?',
                { modal: true },
                'Yes, clear all'
            );
            if (confirm !== 'Yes, clear all') return;

            // Remove all cluster IDs from global state
            const clusterIds = await context.globalState.get<string[]>('esExt.clusterIds', []);
            await context.globalState.update('esExt.clusterIds', []);
            await context.globalState.update('esExt.connectedClusters', []);
            await context.globalState.update('esExt.autoRefreshEnabled', false);

            // Remove all cluster configs and credentials from secrets
            for (const id of clusterIds) {
                await context.secrets.delete(`esExt.cluster.${id}.config`);
                await context.secrets.delete(`esExt.cluster.${id}.username`);
                await context.secrets.delete(`esExt.cluster.${id}.password`);
                await context.secrets.delete(`esExt.cluster.${id}.apiKey`);
            }

            vscode.window.showInformationMessage('All cluster data and credentials have been cleared.');
            explorerProvider.refresh();
        }),

        vscode.commands.registerCommand('esExt.setCACertificate', async () => {
            const fileUris = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: { 'PEM Files': ['pem'], 'All Files': ['*'] },
                openLabel: 'Select CA Certificate (PEM)'
            });
            if (!fileUris || fileUris.length === 0) {
                vscode.window.showInformationMessage('No CA certificate selected.');
                return;
            }
            try {
                const fileUri = fileUris[0];
                const fileContent = await vscode.workspace.fs.readFile(fileUri);
                await context.globalState.update('esExt.caCertificate', Buffer.from(fileContent).toString('utf8'));
                vscode.window.showInformationMessage('CA certificate set. All new cluster connections will use this certificate.');
            } catch (err: any) {
                vscode.window.showErrorMessage('Failed to read CA certificate: ' + err.message);
            }
        }),

        vscode.commands.registerCommand('esExt.clearCACertificate', async () => {
            await context.globalState.update('esExt.caCertificate', undefined);
            vscode.window.showInformationMessage('CA certificate cleared. New connections will not use a custom CA.');
        }),

        vscode.commands.registerCommand('esExt.showRole', async (roleName: string) => {
            const client = explorerProvider.getActiveClient();
            if (!client) {
                vscode.window.showErrorMessage('Please connect to an Elasticsearch cluster first.');
                return;
            }
            try {
                const roles = await client.security.getRole({ name: roleName });
                const roleDef = roles[roleName];
                if (roleDef) {
                    const prettyJson = JSON.stringify(roleDef, null, 2);
                    const doc = await vscode.workspace.openTextDocument({ content: prettyJson, language: 'json' });
                    await vscode.window.showTextDocument(doc, { preview: false });
                } else {
                    vscode.window.showErrorMessage(`Role '${roleName}' not found.`);
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to fetch role '${roleName}': ${err.message}`);
            }
        }),

        vscode.commands.registerCommand('esExt.showRoleMapping', async (mappingName: string) => {
            const client = explorerProvider.getActiveClient();
            if (!client) {
                vscode.window.showErrorMessage('Please connect to an Elasticsearch cluster first.');
                return;
            }
            try {
                const mappings = await client.security.getRoleMapping({ name: mappingName });
                const mappingDef = mappings[mappingName];
                if (mappingDef) {
                    const prettyJson = JSON.stringify(mappingDef, null, 2);
                    const doc = await vscode.workspace.openTextDocument({ content: prettyJson, language: 'json' });
                    await vscode.window.showTextDocument(doc, { preview: false });
                } else {
                    vscode.window.showErrorMessage(`Role mapping '${mappingName}' not found.`);
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to fetch role mapping '${mappingName}': ${err.message}`);
            }
        }),

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
    })
    );
}

export function deactivate() {
    // Clean up any timers or resources
}
