# prophESy

A comprehensive VS Code extension for managing multiple Elasticsearch clusters with secure credential storage and an intuitive tree view interface.

## Repository Name

This repository was renamed to **prophESy**. Please update any local remotes or bookmarks accordingly.

## Features

### 🔗 Multi-Cluster Support
- Add and manage multiple Elasticsearch clusters
- Switch between clusters seamlessly
- Visual cluster selector with connection status
- Support for both self-managed and Elastic Cloud deployments

### 🔐 Secure Authentication
- Multiple authentication methods:
  - No authentication
  - Basic authentication (username/password)
  - API Key authentication
- Secure credential storage using VS Code's SecretStorage API
- SSL certificate verification bypass option for development environments

### 📊 Data Exploration
- Browse cluster information
- View data streams
- Explore security roles and role mappings
- Inspect index templates
- Interactive search functionality

### 🎯 User Interface
- Tree view in VS Code Explorer panel
- Context menus for cluster management
- Progress indicators for connection operations
- Intuitive icons and tooltips

## Installation

1. Clone or download this extension
2. Open in VS Code
3. Press `F5` to launch the Extension Development Host
4. The extension will be available in the new VS Code window

## Usage

### Adding Your First Cluster

1. Open the VS Code Explorer panel
2. Look for the "Elasticsearch Explorer" section
3. Click "Add Elasticsearch Cluster" or use the `+` button
4. Follow the setup wizard:
   - Enter a friendly name for your cluster
   - Choose deployment type (Self-managed or Elastic Cloud)
   - Provide connection details (URL or Cloud ID)
   - Select authentication method
   - Configure SSL settings if needed

### Managing Multiple Clusters

- **Switch clusters**: Click on any cluster in the cluster selector
- **Connect/Disconnect**: Use the context menu or inline buttons
- **Remove clusters**: Right-click and select "Remove" 
- **View cluster info**: Expand the cluster sections to see details

### Exploring Data

Once connected to a cluster, you can:
- **Cluster Info**: View basic cluster information
- **Data Streams**: Browse available data streams
- **Roles**: Explore security roles
- **Role Mappings**: View role mappings
- **Index Templates**: Inspect index templates

### Search Functionality

Use the search command to run Elasticsearch queries:
1. Open Command Palette (`Ctrl+Shift+P`)
2. Type "Elasticsearch: Search"
3. Enter index name (or leave blank for all indices)
4. Enter your query in JSON format
5. Results will open in a new editor tab

## Configuration Examples

### Self-Managed Cluster
```
Name: Production Cluster
Type: Self-managed Cluster
URL: https://elasticsearch.example.com:9200
Auth: Basic (username/password)
SSL: Enabled
```

### Elastic Cloud
```
Name: Development Cloud
Type: Elastic Cloud
Cloud ID: my-deployment:abcdef123456...
Auth: API Key
SSL: Enabled (recommended)
```

### Local Development
```
Name: Local Dev
Type: Self-managed Cluster  
URL: http://localhost:9200
Auth: None
SSL: Disabled
```

## Security Notes

- All credentials are stored securely using VS Code's SecretStorage API
- Credentials are encrypted and stored per-workspace
- SSL certificate verification can be disabled for development (not recommended for production)
- No credentials are logged or exposed in plain text

## Commands

| Command | Description |
|---------|-------------|
| `esExt.addCluster` | Add a new Elasticsearch cluster |
| `esExt.selectCluster` | Switch to a different cluster |
| `esExt.connectToCluster` | Connect to a specific cluster |
| `esExt.removeCluster` | Remove a cluster from the list |
| `esExt.search` | Perform an Elasticsearch search |
| `esExt.refresh` | Refresh the tree view |

## Troubleshooting

### Connection Issues
- Verify your URL/Cloud ID is correct
- Check authentication credentials
- Ensure the cluster is accessible from your network
- For SSL issues, try disabling SSL verification (development only)

### Missing Data
- Ensure you have proper permissions to access the cluster
- Check that the cluster version is compatible
- Verify your authentication method is supported

### Extension Not Loading
- Check VS Code's Output panel for error messages
- Ensure all dependencies are installed (`npm install`)
- Try recompiling the extension (`npm run compile`)

## Development

### Prerequisites
- Node.js 14+ 
- Go 1.21+ (for extension development requirements)
- VS Code 1.50+

### Building
```bash
npm install
npm run compile
```

### Testing
Press `F5` to launch the Extension Development Host for testing.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

This extension is provided as-is for educational and development purposes.

## Support

For issues and feature requests, please check the VS Code Output panel for detailed error messages and logs.
