# Extension Testing Guide - v1.3.0

## 🚀 How to Test the Import/Export Commands

### Step 1: Start Extension Development Host
1. **In this VS Code window**, press `F5` (or go to Run > Start Debugging)
2. This will open a **new VS Code window** titled "Extension Development Host"
3. Wait for the extension to load (you should see "statuESK" in the explorer)

### Step 2: Test Export Command
1. **In the Extension Development Host window**:
   - Open Command Palette: `Ctrl+Shift+P`
   - Type: "Export Clusters"
   - You should see: "ESExt: Export Clusters"
   - Select it to test

### Step 3: Test Import Command
1. **In the Extension Development Host window**:
   - Open Command Palette: `Ctrl+Shift+P`
   - Type: "Import Clusters" 
   - You should see: "ESExt: Import Clusters"
   - Select it to test

### Step 4: Test Important Links ✨ NEW in v1.3.0
1. **In the Extension Development Host window**:
   - Expand any connected cluster in the statuESK view
   - Look for the "Important Links" item with a link-external icon
   - Click to expand it and see three sections:
     - **Elasticsearch**: Cluster health and settings endpoints
     - **Kibana**: Status API, Dev Console, and Stack Monitoring
     - **HAProxy**: Stats page
   - Click on any link to open it in your browser

### Step 5: Test Context Menu

1. **In the Extension Development Host window**:
   - Look for the "statuESK" view in the Explorer panel
   - Right-click on the view title bar
   - You should see "Export Clusters" and "Import Clusters" options

## 🎯 Expected Behavior

### Export:

- If you have clusters configured: Opens save dialog
- If no clusters: Shows message "No clusters to export"

### Import:

- Opens file picker dialog
- Accepts JSON files with cluster configurations
- Handles duplicates with user prompts

### Important Links:

- Links automatically detect PROD vs SAND environments based on cluster name
- PROD clusters use `wtg.zone` domain
- Non-PROD clusters use `sand.wtg.zone` domain
- Elasticsearch links use the actual cluster endpoint
- Kibana and HAProxy links use constructed URLs based on cluster name

## 🎨 New Features in v1.3.0

- **Important Links Section**: Expandable menu with organized service links
- **Environment Detection**: Automatically detects PROD vs SAND based on cluster name
- **Service Categories**: 
  - Elasticsearch: Health and settings API endpoints
  - Kibana: Status, Dev Console, and Stack Monitoring
  - HAProxy: Stats page
- **Smart URL Construction**: Uses cluster configuration and naming conventions

## 🐛 Troubleshooting

**If commands still not found:**

1. Close the Extension Development Host window
2. In the main window, press `Ctrl+Shift+P`
3. Run "Developer: Reload Window"
4. Press `F5` again to restart debugging

**If Important Links don't open:**

- Verify your cluster name follows the expected format
- Check that URLs are being constructed correctly in tooltips
- Ensure you have network access to the target domains

**To see debug output:**

- In Extension Development Host: Help > Toggle Developer Tools
- Check Console tab for any error messages

## 📝 Testing the Enhanced Cluster Info

1. Add an Elasticsearch cluster in the Extension Development Host
2. Connect to the cluster
3. Expand the cluster in the tree view
4. Click "Cluster Info"
5. You should see the enhanced display with:
   - Node counts and shard information
   - Color-coded status indicators (green/yellow/red)
   - Format: "X nodes total, Y data nodes, Z / limit shards - percentage%"

---
**Note**: Always test in the Extension Development Host window, not the main development window!
