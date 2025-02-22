const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
require('dotenv').config(); // Load environment variables

class DataManager {
    constructor() {
        this.dataDir = path.join(__dirname, '../data');
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir);
        }
        this.setupLocalBackup(); // Local backup every 2 minutes
        this.setupAutoPush(); // GitHub backup every 30 minutes
    }

    setupLocalBackup() {
        setInterval(() => {
            this.saveLocalBackup();
        }, 2 * 60 * 1000); // Every 2 minutes
    }

    saveLocalBackup() {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupDir = path.join(this.dataDir, 'backups', timestamp);
        
        try {
            if (!fs.existsSync(path.join(this.dataDir, 'backups'))) {
                fs.mkdirSync(path.join(this.dataDir, 'backups'));
            }
            fs.mkdirSync(backupDir);
            
            // Copy current data files to backup
            const files = ['skulls.json', 'lotteries.json'];
            files.forEach(file => {
                if (fs.existsSync(path.join(this.dataDir, file))) {
                    fs.copyFileSync(
                        path.join(this.dataDir, file),
                        path.join(backupDir, file)
                    );
                }
            });
            console.log(`✅ Local backup created at ${backupDir}`);
            
            // Keep only last 10 backups
            this.cleanOldBackups();
        } catch (error) {
            console.error('❌ Error creating local backup:', error);
        }
    }

    cleanOldBackups() {
        const backupsDir = path.join(this.dataDir, 'backups');
        if (!fs.existsSync(backupsDir)) return;
        
        const backups = fs.readdirSync(backupsDir)
            .map(name => path.join(backupsDir, name))
            .filter(path => fs.statSync(path).isDirectory())
            .sort((a, b) => fs.statSync(b).mtime.getTime() - fs.statSync(a).mtime.getTime());
            
        if (backups.length > 10) {
            backups.slice(10).forEach(dir => {
                fs.rmSync(dir, { recursive: true, force: true });
            });
        }
    }

    saveData(filename, data) {
        console.log("Data to be saved:", data);  // Log the data before saving it
        const filePath = path.join(this.dataDir, filename);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        console.log(`✅ Data saved to ${filePath}`);
    }

    loadData(filename) {
        const filePath = path.join(this.dataDir, filename);
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
        return null;
    }

    setupAutoPush() {
        setInterval(() => {
            this.pushToGitHub();
        }, 30 * 60 * 1000); // Every 30 minutes
    }

    async pushToGitHub() {
        try {
            // Ensure Git is initialized and remote is set
            await this.executeCommand('git init');
            await this.executeCommand(`git remote add origin https://${process.env.GITHUB_USERNAME}:${process.env.GITHUB_TOKEN}@github.com/${process.env.GITHUB_REPO}.git || true`);
            await this.executeCommand('git config user.name "SouldrawBot"');
            await this.executeCommand('git config user.email "bot@example.com"');

            // Add, commit, and push changes
            await this.executeCommand('git add data/*');
            await this.executeCommand('git commit -m "Auto-save data backup" || true'); // Avoid commit errors if nothing changed
            await this.executeCommand('git push origin main');
            console.log('✅ Data successfully pushed to GitHub.');
        } catch (error) {
            console.error('❌ Error pushing data to GitHub:', error);
        }
    }

    async pullFromGitHub() {
        try {
            // Ensure Git is initialized and remote is set
            await this.executeCommand('git init');
            await this.executeCommand(`git remote add origin https://${process.env.GITHUB_USERNAME}:${process.env.GITHUB_TOKEN}@github.com/${process.env.GITHUB_REPO}.git || true`);
            await this.executeCommand('git config user.name "SouldrawBot"');
            await this.executeCommand('git config user.email "bot@example.com"');

            // Fetch and reset to latest backup
            await this.executeCommand('git fetch origin');
            await this.executeCommand('git reset --hard origin/main');
            console.log('✅ Data successfully pulled from GitHub.');
        } catch (error) {
            console.error('❌ Error pulling database from GitHub:', error);
        }
    }

    executeCommand(command) {
        return new Promise((resolve, reject) => {
            exec(command, (error, stdout, stderr) => {
                if (error) {
                    console.error(`❌ Error executing ${command}:`, stderr);
                    reject(stderr);
                } else {
                    console.log(`✅ ${command} executed successfully:`, stdout);
                    resolve(stdout);
                }
            });
        });
    }
}

module.exports = new DataManager();
