# Testing Import/Export Functionality

## Overview
The statuESK extension now includes import and export functionality for Elasticsearch cluster configurations (version 1.1.0).

## Features Added
- **Export Clusters**: Export all cluster configurations to a JSON file (excluding sensitive credentials)
- **Import Clusters**: Import cluster configurations from a JSON file with duplicate handling

## How to Test

### 1. Export Clusters
1. Open VS Code with the statuESK extension installed
2. Open the Command Palette (`Ctrl+Shift+P` or `F1`)
3. Type "Export Clusters" and select the command
4. Choose a location to save the export file
5. The export will include all cluster configurations but exclude sensitive data like passwords and API keys

### 2. Import Clusters
1. Open the Command Palette (`Ctrl+Shift+P` or `F1`)
2. Type "Import Clusters" and select the command
3. Select a previously exported JSON file
4. If duplicate cluster names are found, you'll be prompted to choose:
   - Skip the duplicate
   - Replace the existing cluster
   - Import with a new name

### 3. Access via Context Menu
- Right-click in the Explorer view title bar
- Select "Export Clusters" or "Import Clusters" from the context menu

## Export File Format
The exported JSON file contains:
```json
{
  "version": "1.0",
  "exportDate": "2025-05-28T...",
  "clusters": [
    {
      "name": "Production Cluster",
      "deploymentType": "Self-managed Cluster",
      "nodeUrl": "https://elasticsearch.example.com:9200",
      "authMethod": "Basic: Username/Password",
      "disableSSL": false
    }
  ]
}
```

Note: Sensitive credentials (usernames, passwords, API keys) are intentionally excluded for security.

## Security Features
- Credentials are never exported for security reasons
- After import, you'll need to re-configure authentication for each cluster
- Generated cluster IDs ensure no conflicts during import
- Validation ensures only valid cluster configurations are imported
