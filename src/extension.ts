import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid';
import { exec } from 'child_process';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 64;
const KEY_LENGTH = 32;
const ENCODING = 'utf-8';

interface EnvProject {
    id: string;
    name: string;
    instances: {
        preview: Record<string, EncryptedData>;
        development: Record<string, EncryptedData>;
        production: Record<string, EncryptedData>;
    };
}

interface EncryptedData {
    encrypted: string;
    iv: string;
    tag: string;
    salt: string;
}

type TreeItemType = 'project' | 'instance';

function execShellCommand(cmd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                reject(stderr || stdout);
            } else {
                resolve(stdout.trim());
            }
        });
    });
}

function encrypt(text: string, projectId: string): EncryptedData {
    const iv = crypto.randomBytes(IV_LENGTH);
    const salt = crypto.randomBytes(SALT_LENGTH);
    const key = crypto.pbkdf2Sync(projectId, salt, 100000, KEY_LENGTH, 'sha512');

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(text, ENCODING, 'base64');
    encrypted += cipher.final('base64');

    return {
        encrypted: encrypted,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        salt: salt.toString('base64')
    };
}

function decrypt(encryptedData: EncryptedData, projectId: string): string {
    const key = crypto.pbkdf2Sync(
        projectId,
        Buffer.from(encryptedData.salt, 'base64'),
        100000,
        KEY_LENGTH,
        'sha512'
    );

    const decipher = crypto.createDecipheriv(
        ALGORITHM,
        key,
        Buffer.from(encryptedData.iv, 'base64')
    );

    decipher.setAuthTag(Buffer.from(encryptedData.tag, 'base64'));

    let decrypted = decipher.update(encryptedData.encrypted, 'base64', ENCODING);
    decrypted += decipher.final(ENCODING);

    return decrypted;
}

async function checkGitHubAuth(): Promise<void> {
    try {
        await execShellCommand('gh auth status');
    } catch (error) {
        throw new Error('GitHub CLI is not authenticated. Please run "gh auth login" in the terminal.');
    }
}

async function getGitHubUsername(): Promise<string> {
    return execShellCommand('gh api user -q ".login"');
}

async function ensureGitHubRepo(username: string, repoName: string): Promise<void> {
    try {
        await execShellCommand(`gh repo view ${username}/${repoName}`);
    } catch {
        await execShellCommand(`gh repo create ${repoName} --private --confirm`);
    }
}

async function backupToGitHub(context: vscode.ExtensionContext): Promise<void> {
    const outputChannel = vscode.window.createOutputChannel('GitHub Operations');
    outputChannel.show();
    outputChannel.appendLine('Starting backup process...');

    try {
        await checkGitHubAuth();
        const repoName = "tryEnv-Backup";
        const username = await getGitHubUsername();
        await ensureGitHubRepo(username, repoName);

        const storagePath = context.globalStorageUri.fsPath;
        const projectsFilePath = path.join(storagePath, 'projects.json');

        const projects = JSON.parse(fs.readFileSync(projectsFilePath, 'utf8'));
        fs.writeFileSync(projectsFilePath, JSON.stringify(projects, null, 2));

        await execShellCommand(`cd ${storagePath} && git init`);

        try {
            await execShellCommand(`cd ${storagePath} && git remote get-url origin`);
        } catch {
            await execShellCommand(
                `cd ${storagePath} && git remote add origin https://github.com/${username}/${repoName}.git`
            );
        }

        await execShellCommand(`cd ${storagePath} && git add projects.json`);
        await execShellCommand(
            `cd ${storagePath} && git commit -m "Backup at ${new Date().toISOString()}"`
        );
        await execShellCommand(`cd ${storagePath} && git push -u origin master --force`);

        outputChannel.appendLine('Backup completed successfully!');
        vscode.window.showInformationMessage('Successfully backed up to GitHub');
    } catch (error) {
        outputChannel.appendLine(`Backup failed: ${(error as Error).message}`);
        vscode.window.showErrorMessage(`Backup failed: ${(error as Error).message}`);
        throw error;
    }
}

async function syncFromGitHub(context: vscode.ExtensionContext): Promise<void> {
    const outputChannel = vscode.window.createOutputChannel('GitHub Operations');
    outputChannel.show();
    outputChannel.appendLine('Starting sync process...');

    try {
        await checkGitHubAuth();

        const repoName = "tryEnv-Backup";
        const username = await getGitHubUsername();
        const storagePath = context.globalStorageUri.fsPath;
        const projectsFilePath = path.join(storagePath, 'projects.json');
        const tempDir = path.join(storagePath, 'temp_sync');

        if (fs.existsSync(projectsFilePath)) {
            const localProjects = JSON.parse(fs.readFileSync(projectsFilePath, 'utf8'));
            if (localProjects.length > 0) {
                const decision = await vscode.window.showWarningMessage(
                    'Syncing will overwrite your local data. Any unsynced changes will be lost.',
                    'Backup First',
                    'Proceed Anyway',
                    'Cancel'
                );

                if (decision === 'Cancel') {
                    outputChannel.appendLine('Sync cancelled by user');
                    return;
                }
                if (decision === 'Backup First') {
                    await backupToGitHub(context);
                }
            }
        }

        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        fs.mkdirSync(tempDir, { recursive: true });

        outputChannel.appendLine('Cloning repository...');
        await execShellCommand(
            `cd ${tempDir} && git clone https://github.com/${username}/${repoName}.git`
        );

        const backupFilePath = path.join(tempDir, repoName, 'projects.json');

        if (!fs.existsSync(backupFilePath)) {
            throw new Error('No backup file found in repository');
        }

        try {
            const backupData = JSON.parse(fs.readFileSync(backupFilePath, 'utf8'));
            if (!Array.isArray(backupData)) {
                throw new Error('Invalid backup data format');
            }

            if (!fs.existsSync(path.dirname(projectsFilePath))) {
                fs.mkdirSync(path.dirname(projectsFilePath), { recursive: true });
            }

            fs.copyFileSync(backupFilePath, projectsFilePath);

            fs.rmSync(tempDir, { recursive: true, force: true });

            outputChannel.appendLine('Sync completed successfully!');
            vscode.window.showInformationMessage('Successfully synced from GitHub');

            return;
        } catch (error) {
            throw new Error(`Failed to validate backup data: ${(error as Error).message}`);
        }
    } catch (error) {
        outputChannel.appendLine(`Sync failed: ${(error as Error).message}`);
        vscode.window.showErrorMessage(`Sync failed: ${(error as Error).message}`);
        throw error;
    }
}

class ProjectTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly projectId: string,
        public readonly type: TreeItemType,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly instance?: string,
        public readonly command?: vscode.Command
    ) {
        super(label, collapsibleState);

        this.contextValue = type;

        if (type === 'instance') {
            this.iconPath = new vscode.ThemeIcon('window');
        } else {
            this.iconPath = new vscode.ThemeIcon('gist-secret');
        }
    }
}

class ProjectTreeDataProvider implements vscode.TreeDataProvider<ProjectTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ProjectTreeItem | undefined | null | void> =
        new vscode.EventEmitter<ProjectTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ProjectTreeItem | undefined | null | void> =
        this._onDidChangeTreeData.event;

    constructor(private projectsFilePath: string) {
        this.loadProjects();
    }

    private _projects: EnvProject[] = [];

    refresh(): void {
        this.loadProjects();
        this._onDidChangeTreeData.fire();
    }

    private loadProjects() {
        try {
            if (fs.existsSync(this.projectsFilePath)) {
                const data = fs.readFileSync(this.projectsFilePath, 'utf8');
                this._projects = JSON.parse(data);
            } else {
                this._projects = [];
            }
        } catch (error) {
            console.error('Error loading projects:', error);
            this._projects = [];
            vscode.window.showErrorMessage('Failed to load projects');
        }
    }

    getTreeItem(element: ProjectTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ProjectTreeItem): Thenable<ProjectTreeItem[]> {
        if (!element) {
            return Promise.resolve(
                this._projects.map(project => new ProjectTreeItem(
                    project.name,
                    project.id,
                    'project',
                    vscode.TreeItemCollapsibleState.Collapsed
                ))
            );
        } else if (element.type === 'project') {
            const instances = ['preview', 'development', 'production'];
            return Promise.resolve(
                instances.map(instance => new ProjectTreeItem(
                    instance.charAt(0).toUpperCase() + instance.slice(1),
                    element.projectId,
                    'instance',
                    vscode.TreeItemCollapsibleState.None,
                    instance,
                    {
                        command: 'tryenv.openProject',
                        title: 'Open Project',
                        arguments: [this._projects.find(p => p.id === element.projectId), instance]
                    }
                ))
            );
        }
        return Promise.resolve([]);
    }
}

export function activate(context: vscode.ExtensionContext) {
    const storagePath = context.globalStorageUri.fsPath;
    const projectsFilePath = path.join(storagePath, 'projects.json');

    if (!fs.existsSync(storagePath)) {
        fs.mkdirSync(storagePath, { recursive: true });
    }

    if (!fs.existsSync(projectsFilePath)) {
        fs.writeFileSync(projectsFilePath, JSON.stringify([]));
    }

    const treeDataProvider = new ProjectTreeDataProvider(projectsFilePath);
    vscode.window.registerTreeDataProvider('tryenvExplorer', treeDataProvider);

    let currentPanel: vscode.WebviewPanel | undefined = undefined;

    // Register Sync Command
    context.subscriptions.push(
        vscode.commands.registerCommand('tryenv.syncFromGitHub', async () => {
            try {
                await syncFromGitHub(context);
                treeDataProvider.refresh();
            } catch (error) {
                console.error('Sync failed:', error);
                throw error;
            }
        })
    );

    // Register Backup Command
    context.subscriptions.push(
        vscode.commands.registerCommand('tryenv.backupToGitHub', async () => {
            try {
                await backupToGitHub(context);
            } catch (error) {
                console.error('Backup failed:', error);
                throw error;
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('tryenv.renameProject', async (item: ProjectTreeItem) => {
            const newName = await vscode.window.showInputBox({
                prompt: 'Enter new project name',
                placeHolder: item.label,
                value: item.label
            });

            if (newName) {
                const projects = JSON.parse(fs.readFileSync(projectsFilePath, 'utf8'));
                const projectToUpdate = projects.find((p: EnvProject) => p.id === item.projectId);
                if (projectToUpdate) {
                    projectToUpdate.name = newName;
                    fs.writeFileSync(projectsFilePath, JSON.stringify(projects, null, 2));
                    treeDataProvider.refresh();

                    if (currentPanel && currentPanel.title.startsWith('TryEnv:')) {
                        currentPanel.title = `TryEnv: ${newName}`;
                    }
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('tryenv.deleteProject', async (item: ProjectTreeItem) => {
            const confirmation = await vscode.window.showWarningMessage(
                `Are you sure you want to delete project "${item.label}"?`,
                'Yes',
                'No'
            );

            if (confirmation === 'Yes') {
                const projects = JSON.parse(fs.readFileSync(projectsFilePath, 'utf8'));
                const updatedProjects = projects.filter((p: EnvProject) => p.id !== item.projectId);
                fs.writeFileSync(projectsFilePath, JSON.stringify(updatedProjects, null, 2));
                treeDataProvider.refresh();

                if (currentPanel && currentPanel.title === `TryEnv: ${item.label}`) {
                    currentPanel.dispose();
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('tryenv.createProject', async () => {
            const projectName = await vscode.window.showInputBox({
                prompt: 'Enter project name',
                placeHolder: 'My Project'
            });

            if (projectName) {
                const newProject: EnvProject = {
                    id: uuidv4(),
                    name: projectName,
                    instances: {
                        preview: {},
                        development: {},
                        production: {}
                    }
                };

                const projects = JSON.parse(fs.readFileSync(projectsFilePath, 'utf8'));
                projects.push(newProject);
                fs.writeFileSync(projectsFilePath, JSON.stringify(projects, null, 2));
                treeDataProvider.refresh();
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('tryenv.openProject', (project: EnvProject, instance?: string) => {
            if (currentPanel) {
                currentPanel.reveal(vscode.ViewColumn.One);
                updateProjectPanel(currentPanel, project, context.extensionUri, instance);
            } else {
                currentPanel = vscode.window.createWebviewPanel(
                    'tryenvProject',
                    `TryEnv: ${project.name}${instance ? ` (${instance})` : ''}`,
                    vscode.ViewColumn.One,
                    {
                        enableScripts: true,
                        retainContextWhenHidden: true,
                        localResourceRoots: [context.extensionUri]
                    }
                );

                updateProjectPanel(currentPanel, project, context.extensionUri, instance);

                currentPanel.onDidDispose(
                    () => {
                        currentPanel = undefined;
                    },
                    null,
                    context.subscriptions
                );

                currentPanel.webview.onDidReceiveMessage(
                    async message => {
                        const projects = JSON.parse(fs.readFileSync(projectsFilePath, 'utf8'));
                        const projectToUpdate = projects.find((p: EnvProject) => p.id === message.projectId);

                        if (!projectToUpdate) { return; }

                        switch (message.type) {
                            case 'addVariable':
                                if (message.key && message.value) {
                                    projectToUpdate.instances[message.instance][message.key] = encrypt(
                                        message.value,
                                        projectToUpdate.id
                                    );
                                }
                                break;
                            case 'editVariable':
                                const newValue = await vscode.window.showInputBox({
                                    prompt: `Edit value for ${message.key}`,
                                    value: decrypt(
                                        projectToUpdate.instances[message.instance][message.key],
                                        projectToUpdate.id
                                    )
                                });
                                if (newValue !== undefined) {
                                    projectToUpdate.instances[message.instance][message.key] = encrypt(
                                        newValue,
                                        projectToUpdate.id
                                    );
                                }
                                break;
                            case 'deleteVariable':
                                delete projectToUpdate.instances[message.instance][message.key];
                                break;
                            case 'addMultipleVariables':
                                for (const variable of message.variables) {
                                    projectToUpdate.instances[message.instance][variable.key] = encrypt(
                                        variable.value,
                                        projectToUpdate.id
                                    );
                                }
                                break;
                        }

                        fs.writeFileSync(projectsFilePath, JSON.stringify(projects, null, 2));
                        treeDataProvider.refresh();
                        updateProjectPanel(currentPanel!, projectToUpdate, context.extensionUri, message.instance);
                    },
                    undefined,
                    context.subscriptions
                );
            }
        })
    );
}

function updateProjectPanel(
    panel: vscode.WebviewPanel,
    project: EnvProject,
    extensionUri: vscode.Uri,
    activeInstance?: string
) {
    const instances = activeInstance ? [activeInstance] : ['preview', 'development', 'production'];

    panel.title = `TryEnv: ${project.name}${activeInstance ? ` (${activeInstance})` : ''}`;
    panel.webview.html = `
<!DOCTYPE html>
<html>
<head>
    <style>
        :root {
            --input-padding: 4px 8px;
            --border-radius: 4px;
            --button-padding: 6px 12px;
        }

        body {
            padding: 0;
            color: var(--vscode-foreground);
            font-family: var(--vscode-font-family);
            margin: 0;
            width: 100vw;
            height: 100vh;
            overflow-x: hidden;
            background: var(--vscode-editor-background);
        }

        .main-container {
            padding: 20px;
            max-width: 100%;
            box-sizing: border-box;
        }

        .section {
            margin-bottom: 32px;
            width: 100%;
        }

        .section-title {
            margin-bottom: 16px;
            padding: 0 16px;
            color: var(--vscode-foreground);
        }

        .data-grid-container {
            margin: 20px 0;
            width: 100%;
            overflow-x: auto;
        }

        .data-grid {
            display: grid;
            grid-template-columns: minmax(250px, 2fr) minmax(350px, 3fr) minmax(200px, 1fr);
            gap: 1px;
            width: 100%;
            background-color: var(--vscode-panel-border);
        }

        .grid-header {
            background-color: var(--vscode-editor-background);
            padding: 12px 16px;
            font-weight: bold;
            display: flex;
            align-items: center;
        }

        .grid-row {
            display: contents;
        }

        .grid-row:hover .grid-cell {
            background-color: var(--vscode-list-hoverBackground);
        }

        .grid-cell {
            padding: 8px 16px;
            background-color: var(--vscode-editor-background);
            min-height: 40px;
            display: flex;
            align-items: center;
        }

        .button-container {
            display: flex;
            gap: 8px;
            justify-content: flex-end;
        }

        .input-row {
            display: contents;
        }

        .empty-state {
            grid-column: 1 / -1;
            text-align: center;
            padding: 32px;
            background-color: var(--vscode-editor-background);
        }

        .badge {
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 12px;
        }

        .bulk-input-section {
            margin: 24px 16px;
            background-color: var(--vscode-editor-background);
            padding: 20px;
            border-radius: 4px;
            border: 1px solid var(--vscode-panel-border);
        }

        .bulk-input-section h3 {
            margin-top: 0;
            margin-bottom: 16px;
            color: var(--vscode-foreground);
        }

        /* Custom Tab Styling */
        .tabs {
            display: flex;
            border-bottom: 1px solid var(--vscode-panel-border);
            margin-bottom: 20px;
        }

        .tab {
            padding: 8px 16px;
            cursor: pointer;
            border: none;
            background: none;
            color: var(--vscode-foreground);
            opacity: 0.7;
            transition: opacity 0.2s;
        }

        .tab.active {
            opacity: 1;
            border-bottom: 2px solid var(--vscode-focusBorder);
        }

        .tab:hover {
            opacity: 1;
        }

        .tab-content {
            display: none;
        }

        .tab-content.active {
            display: block;
        }

        /* Form Controls */
        input[type="text"], textarea {
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: var(--input-padding);
            border-radius: var(--border-radius);
            width: 100%;
            font-family: var(--vscode-font-family);
            box-sizing: border-box;
        }

        input[type="text"]:focus, textarea:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
        }

        textarea {
            min-height: 120px;
            resize: vertical;
        }

        button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: var(--button-padding);
            border-radius: var(--border-radius);
            cursor: pointer;
            font-family: var(--vscode-font-family);
            transition: background-color 0.2s;
        }

        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        button.secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        button.secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }

        .value-cell {
            font-family: var(--vscode-editor-font-family);
            word-break: break-all;
        }
    </style>
</head>
<body>
    <div class="main-container">
        <div class="tabs">
            ${instances.map((instance, index) => `
                <button class="tab ${index === 0 ? 'active' : ''}" 
                        onclick="switchTab('${instance}')">${
                        instance.charAt(0).toUpperCase() + instance.slice(1)
                        }</button>
            `).join('')}
        </div>

        ${instances.map((instance, index) => `
        <div class="tab-content ${index === 0 ? 'active' : ''}" id="content-${instance}">
            <div class="section">
                <h2 class="section-title">${
                    instance.charAt(0).toUpperCase() + instance.slice(1)
                } Environment Variables</h2>

                <div class="data-grid-container">
                    <div class="data-grid">
                        <div class="grid-header">Variable Name</div>
                        <div class="grid-header">Value</div>
                        <div class="grid-header">Actions</div>

                        <div class="input-row">
                            <div class="grid-cell">
                                <input type="text" id="new-key-${instance}" 
                                       placeholder="Enter variable name">
                            </div>
                            <div class="grid-cell">
                                <input type="text" id="new-value-${instance}" 
                                       placeholder="Enter variable value">
                            </div>
                            <div class="grid-cell">
                                <div class="button-container">
                                    <button onclick="addVariable('${instance}', '${project.id}')">
                                        Add Variable
                                    </button>
                                </div>
                            </div>
                        </div>

                        ${Object.entries(project.instances[instance as keyof typeof project.instances]).length > 0 ?
                            Object.entries(project.instances[instance as keyof typeof project.instances])
                                .map(([key, encryptedValue]) => {
                                    const decryptedValue = decrypt(encryptedValue, project.id);
                                    return `
                                    <div class="grid-row">
                                        <div class="grid-cell">${key}</div>
                                        <div class="grid-cell value-cell">${decryptedValue}</div>
                                        <div class="grid-cell">
                                            <div class="button-container">
                                                <button class="secondary" 
                                                        onclick="editVariable('${instance}', '${project.id}', '${key}')">
                                                    Edit
                                                </button>
                                                <button class="secondary" 
                                                        onclick="deleteVariable('${instance}', '${project.id}', '${key}')">
                                                    Delete
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                    `;
                                }).join('')
                            : `
                            <div class="empty-state">
                                <span class="badge">No variables defined yet. Add one above.</span>
                            </div>
                            `
                        }
                    </div>
                </div>

                <div class="bulk-input-section">
                    <h3>Bulk Add Variables</h3>
                    <textarea id="paste-area-${instance}" 
                              placeholder="Paste your environment variables here (e.g., KEY=value or KEY='value')"></textarea>
                    <button onclick="handlePaste('${instance}', '${project.id}')">
                        Add Variables
                    </button>
                </div>
            </div>
        </div>
        `).join('')}
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        function switchTab(instanceId) {
            // Hide all content
            document.querySelectorAll('.tab-content').forEach(content => {
                content.classList.remove('active');
            });
            
            // Deactivate all tabs
            document.querySelectorAll('.tab').forEach(tab => {
                tab.classList.remove('active');
            });
            
            // Show selected content and activate tab
            document.getElementById('content-' + instanceId).classList.add('active');
            document.querySelector(\`.tab[onclick="switchTab('\${instanceId}')"]\`).classList.add('active');
        }

        function addVariable(instance, projectId) {
            const keyInput = document.getElementById('new-key-' + instance);
            const valueInput = document.getElementById('new-value-' + instance);

            const key = keyInput.value.trim();
            const value = valueInput.value.trim();

            if (key && value) {
                vscode.postMessage({
                    type: 'addVariable',
                    instance: instance,
                    projectId: projectId,
                    key: key,
                    value: value
                });

                keyInput.value = '';
                valueInput.value = '';
            }
        }

        function editVariable(instance, projectId, key) {
            vscode.postMessage({
                type: 'editVariable',
                instance: instance,
                projectId: projectId,
                key: key
            });
        }

        function deleteVariable(instance, projectId, key) {
            vscode.postMessage({
                type: 'deleteVariable',
                instance: instance,
                projectId: projectId,
                key: key
            });
        }

        function handlePaste(instance, projectId) {
            const pasteArea = document.getElementById('paste-area-' + instance);
            const content = pasteArea.value.trim();

            if (!content) {
                return;
            }

            const lines = content.split('\\n');
            const variables = [];

            for (const line of lines) {
                const trimmedLine = line.trim();
                const parsed = parseEnvLine(trimmedLine);
                if (parsed) {
                    variables.push(parsed);
                }
            }

            if (variables.length > 0) {
                vscode.postMessage({
                    type: 'addMultipleVariables',
                    instance: instance,
                    projectId: projectId,
                    variables: variables
                });

                pasteArea.value = '';
            }
        }

        function parseEnvLine(line) {
            if (!line || line.trim().startsWith('#')) {
                return null;
            }

            const firstEquals = line.indexOf('=');
            if (firstEquals === -1) {
                return null;
            }

            const key = line.substring(0, firstEquals).trim();
            let value = line.substring(firstEquals + 1).trim();

            if (!key) {
                return null;
            }

            if (value) {
                const firstChar = value.charAt(0);
                const lastChar = value.charAt(value.length - 1);

                if ((firstChar === '"' && lastChar === '"') ||
                    (firstChar === "'" && lastChar === "'") ||
                    (firstChar === '\`' && lastChar === '\`')) {
                    value = value.slice(1, -1);
                }
            }

            return { key, value: value || '' };
        }

        document.addEventListener('keypress', function (event) {
            if (event.key === 'Enter') {
                const target = event.target;
                if (target.id && target.id.startsWith('new-')) {
                    const instance = target.id.split('-')[2];
                    addVariable(instance, '${project.id}');
                }
            }
        });
    </script>
</body>
</html>`;
}

export function deactivate() { }