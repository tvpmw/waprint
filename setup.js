const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

class SetupWizard {
    constructor() {
        this.configPath = path.join(__dirname, 'config.json');
        this.tempDir = path.join(__dirname, 'temp');
    }

    async run() {
        console.log('🚀 WhatsApp Print Server Setup Wizard');
        console.log('=====================================\n');

        try {
            await this.createDirectories();
            await this.createConfig();
            await this.detectPrinters();
            await this.showFinalInstructions();
        } catch (error) {
            console.error('❌ Setup gagal:', error.message);
            process.exit(1);
        }
    }

    async createDirectories() {
        console.log('📁 Membuat direktori yang diperlukan...');
        
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
            console.log('✅ Direktori temp dibuat');
        }

        const logDir = path.join(__dirname, 'logs');
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
            console.log('✅ Direktori logs dibuat');
        }
    }

    async createConfig() {
        console.log('\n⚙️ Membuat file konfigurasi...');

        const defaultConfig = {
            printSettings: {
                allowedFormats: ['.pdf', '.doc', '.docx', '.jpg', '.jpeg', '.png', '.txt'],
                maxFileSize: 10485760, 
                printerName: 'default',
                defaultCopies: 1,
                allowedUsers: [], 
                autoCleanup: true,
                cleanupInterval: 1800000 
            },
            bot: {
                adminNumbers: [], 
                enableLogging: true,
                responseLanguage: 'id'
            },
            security: {
                enableRateLimit: true,
                maxRequestsPerHour: 50,
                enableFileValidation: true,
                quarantineEnabled: false
            }
        };

        fs.writeFileSync(this.configPath, JSON.stringify(defaultConfig, null, 2));
        console.log('✅ File config.json dibuat');
    }

    async detectPrinters() {
        console.log('\n🖨️ Mendeteksi printer yang tersedia...');

        return new Promise((resolve) => {
            let command;
            
            if (process.platform === 'win32') {
                command = 'wmic printer get name';
            } else if (process.platform === 'darwin') {
                command = 'lpstat -p';
            } else {
                command = 'lpstat -p';
            }

            exec(command, (error, stdout, stderr) => {
                if (error) {
                    console.log('⚠️ Tidak dapat mendeteksi printer otomatis');
                    console.log('   Pastikan printer sudah terinstall dan terhubung');
                } else {
                    console.log('✅ Printer terdeteksi:');
                    console.log(stdout);
                }
                resolve();
            });
        });
    }

    async showFinalInstructions() {
        console.log('\n🎉 Setup berhasil!');
        console.log('==================\n');

        console.log('📋 Langkah selanjutnya:');
        console.log('1. Edit config.json untuk menyesuaikan pengaturan');
        console.log('2. Jalankan: npm start');
        console.log('3. Scan QR Code dengan WhatsApp');
        console.log('4. Bot siap digunakan!\n');

        console.log('⚙️ Konfigurasi penting:');
        console.log('• Edit config.json untuk mengatur printer default');
        console.log('• Tambahkan nomor admin di bot.adminNumbers');
        console.log('• Sesuaikan allowedUsers jika perlu pembatasan akses\n');

        console.log('🚀 Untuk menjalankan bot:');
        console.log('   npm start\n');

        console.log('📁 File konfigurasi: config.json');
        console.log('📁 File sementara: temp/');
        console.log('📁 Log aplikasi: logs/\n');

        console.log('💡 Tips:');
        console.log('• Gunakan PM2 untuk production: npm install -g pm2 && pm2 start bot.js');
        console.log('• Monitor logs: tail -f logs/bot.log');
        console.log('• Restart bot jika ada masalah koneksi WhatsApp');
    }
}

const setup = new SetupWizard();
setup.run();