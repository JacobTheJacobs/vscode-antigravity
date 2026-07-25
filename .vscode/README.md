# VS Code Configuration

## Launch Configuration Setup

To set up debugging for this extension:

1. Copy `launch.json.example` to `launch.json`:

   ```bash
   cp .vscode/launch.json.example .vscode/launch.json
   ```

2. Edit `.vscode/launch.json` and replace `/path/to/your/workspace` with your actual workspace folder path.
   - For example: `/Users/username/projects` on macOS/Linux
   - Or: `C:\\Users\\username\\projects` on Windows

3. The `launch.json` file is gitignored to keep personal paths private.

## Note

The actual `launch.json` file is not tracked in git to avoid sharing personal file paths. Each developer should create their own based on the template.
