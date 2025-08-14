const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const { exec, spawn } = require('child_process');
const mime = require('mime-types');
const axios = require('axios');

class EnhancedWhatsAppPrintBot {
    constructor() {
        this.configPath = path.join(__dirname, 'config.json');
        this.config = this.loadConfig();
        
        this.client = new Client({
            authStrategy: new LocalAuth(),
            puppeteer: {
                headless: true,
                args: [
                    '--no-sandbox', 
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu'
                ]
            }
        });

        this.printQueue = new Map();
        this.userSessions = new Map();
        this.userStats = new Map();
        this.rateLimit = new Map();
        this.adminNumbers = new Set(this.config.bot.adminNumbers);
        this.printHistory = [];
        this.printerStatus = { online: true, lastCheck: Date.now() };

        this.initBot();
        this.initLogging();
        this.startPeriodicTasks();
    }

    loadConfig() {
        try {
            if (fs.existsSync(this.configPath)) {
                return JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
            }
        } catch (error) {
            console.error('Error loading config:', error);
        }

        return {
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
    }

    initLogging() {
        if (!this.config.bot.enableLogging) return;

        const logDir = path.join(__dirname, 'logs');
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }

        this.logFile = path.join(logDir, `bot-${new Date().toISOString().split('T')[0]}.log`);
    }

    log(level, message, data = null) {
        const timestamp = new Date().toISOString();
        const logEntry = `[${timestamp}] ${level.toUpperCase()}: ${message}`;
        
        console.log(logEntry);
        
        if (this.config.bot.enableLogging) {
            const fullEntry = data ? `${logEntry} | Data: ${JSON.stringify(data)}\n` : `${logEntry}\n`;
            fs.appendFileSync(this.logFile, fullEntry);
        }
    }

    initBot() {
        this.client.on('qr', (qr) => {
            console.log('🔗 Scan QR Code berikut untuk login:');
            qrcode.generate(qr, { small: true });
            this.log('info', 'QR Code generated for WhatsApp login');
        });

        this.client.on('ready', () => {
            console.log('🤖 Enhanced WhatsApp Print Bot siap digunakan!');
            console.log(`📱 Terhubung sebagai: ${this.client.info.pushname}`);
            console.log(`📞 Nomor: ${this.client.info.wid.user}`);
            this.log('info', 'Bot connected successfully', { 
                name: this.client.info.pushname, 
                number: this.client.info.wid.user 
            });
        });

        this.client.on('message', async (message) => {
            await this.handleMessage(message);
        });

        this.client.on('disconnected', (reason) => {
            console.log('❌ Bot terputus:', reason);
            this.log('error', 'Bot disconnected', { reason });
        });

        this.client.on('auth_failure', (message) => {
            console.error('❌ Autentikasi gagal:', message);
            this.log('error', 'Authentication failed', { message });
        });

        this.client.initialize();
    }

    async handleMessage(message) {
        const chatId = message.from;
        const isGroup = message.from.includes('@g.us');
        const userNumber = message.from.replace('@c.us', '');
        
        if (isGroup && !message.mentionedIds.includes(this.client.info.wid._serialized)) {
            return;
        }

        if (this.config.security.enableRateLimit && !this.isAdmin(userNumber)) {
            if (!this.checkRateLimit(userNumber)) {
                await message.reply('⏳ Anda telah mencapai batas maksimal request per jam. Coba lagi nanti.');
                return;
            }
        }

        if (this.config.printSettings.allowedUsers.length > 0 && !this.isAdmin(userNumber)) {
            if (!this.config.printSettings.allowedUsers.includes(userNumber)) {
                await message.reply('❌ Maaf, Anda tidak memiliki akses ke layanan print ini.');
                this.log('warn', 'Unauthorized access attempt', { user: userNumber });
                return;
            }
        }

        this.log('info', 'Message received', { 
            from: userNumber, 
            type: message.type, 
            hasMedia: message.hasMedia 
        });

        this.updateUserStats(userNumber);

        const messageBody = message.body.toLowerCase().trim();

        if (this.isAdmin(userNumber) && messageBody.startsWith('/admin')) {
            await this.handleAdminCommand(message, messageBody);
            return;
        }

        if (messageBody.startsWith('/')) {
            await this.handleCommand(message, messageBody);
            return;
        }

        if (message.hasMedia) {
            await this.handleFileMessage(message);
            return;
        }

        if (this.userSessions.has(chatId)) {
            await this.handleUserResponse(message);
            return;
        }

        await this.sendHelpMessage(message);
    }

    isAdmin(userNumber) {
        return this.adminNumbers.has(userNumber);
    }

    checkRateLimit(userNumber) {
        const now = Date.now();
        const hourAgo = now - (60 * 60 * 1000);
        
        if (!this.rateLimit.has(userNumber)) {
            this.rateLimit.set(userNumber, []);
        }

        const userRequests = this.rateLimit.get(userNumber);
        
        const recentRequests = userRequests.filter(timestamp => timestamp > hourAgo);
        this.rateLimit.set(userNumber, recentRequests);

        if (recentRequests.length >= this.config.security.maxRequestsPerHour) {
            return false;
        }

        recentRequests.push(now);
        return true;
    }

    updateUserStats(userNumber) {
        if (!this.userStats.has(userNumber)) {
            this.userStats.set(userNumber, {
                totalRequests: 0,
                totalPrints: 0,
                totalPages: 0,
                firstSeen: Date.now(),
                lastSeen: Date.now()
            });
        }

        const stats = this.userStats.get(userNumber);
        stats.totalRequests++;
        stats.lastSeen = Date.now();
    }

    async handleAdminCommand(message, command) {
        const parts = command.split(' ');
        const adminCmd = parts[1];

        switch (adminCmd) {
            case 'stats':
                await this.sendBotStats(message);
                break;
            
            case 'users':
                await this.sendUserStats(message);
                break;
            
            case 'queue':
                await this.sendDetailedQueue(message);
                break;
            
            case 'printer':
                if (parts[2] === 'check') {
                    await this.checkPrinterStatus(message);
                } else if (parts[2] === 'test') {
                    await this.testPrint(message);
                }
                break;
            
            case 'config':
                await this.sendConfigInfo(message);
                break;
            
            case 'logs':
                await this.sendRecentLogs(message);
                break;
            
            case 'broadcast':
                const broadcastMsg = parts.slice(2).join(' ');
                if (broadcastMsg) {
                    await this.broadcastMessage(broadcastMsg);
                    await message.reply('✅ Broadcast terkirim ke semua user aktif.');
                }
                break;
            
            default:
                await message.reply(`
🔧 *Admin Commands:*

• /admin stats - Statistik bot
• /admin users - Statistik user
• /admin queue - Detail antrian
• /admin printer check - Cek printer
• /admin printer test - Test print
• /admin config - Info konfigurasi
• /admin logs - Log terbaru
• /admin broadcast <pesan> - Broadcast ke semua user`);
        }
    }

    async handleCommand(message, command) {
        const chatId = message.from;
        const userNumber = message.from.replace('@c.us', '');

        switch (command) {
            case '/start':
            case '/help':
                await this.sendHelpMessage(message);
                break;

            case '/status':
                await this.sendPrintStatus(message);
                break;

            case '/queue':
                await this.sendQueueStatus(message);
                break;

            case '/cancel':
                await this.cancelPrintJob(message);
                break;

            case '/settings':
                await this.sendSettingsInfo(message);
                break;

            case '/history':
                await this.sendUserHistory(message, userNumber);
                break;

            case '/formats':
                await this.sendSupportedFormats(message);
                break;

            case '/ping':
                const startTime = Date.now();
                const reply = await message.reply('🏓 Pong!');
                const endTime = Date.now();
                await reply.edit(`🏓 Pong! (${endTime - startTime}ms)`);
                break;

            default:
                await message.reply('❌ Command tidak dikenal. Ketik /help untuk melihat daftar command.');
        }
    }

    async handleFileMessage(message) {
        const chatId = message.from;
        const userNumber = message.from.replace('@c.us', '');
        
        try {
            this.log('info', 'Processing file upload', { user: userNumber });

            await message.reply('📥 Mengunduh file... Mohon tunggu sebentar.');
            const media = await message.downloadMedia();
            
            if (!media) {
                await message.reply('❌ Gagal mengunduh file. Silakan coba lagi.');
                this.log('error', 'Failed to download media', { user: userNumber });
                return;
            }

            const validationResult = await this.validateFile(media, userNumber);
            if (!validationResult.valid) {
                await message.reply(validationResult.message);
                return;
            }

            const fileName = `print_${userNumber}_${Date.now()}.${validationResult.extension}`;
            const filePath = path.join(__dirname, 'temp', fileName);
            
            if (!fs.existsSync(path.dirname(filePath))) {
                fs.mkdirSync(path.dirname(filePath), { recursive: true });
            }

            fs.writeFileSync(filePath, media.data, 'base64');

            const fileAnalysis = await this.analyzeFile(filePath, validationResult.extension);

            const printJob = {
                id: Date.now().toString(),
                fileName,
                originalName: media.filename || fileName,
                filePath,
                extension: validationResult.extension,
                pageCount: fileAnalysis.pageCount,
                fileSize: validationResult.fileSize,
                chatId,
                userNumber,
                status: 'pending',
                copies: this.config.printSettings.defaultCopies,
                printOptions: {
                    color: fileAnalysis.hasColor,
                    duplex: false,
                    paperSize: 'A4',
                    quality: 'normal'
                },
                createdAt: new Date(),
                estimatedCost: this.calculatePrintCost(fileAnalysis.pageCount, fileAnalysis.hasColor)
            };

            this.printQueue.set(printJob.id, printJob);

            const confirmationMessage = this.buildConfirmationMessage(printJob, fileAnalysis);
            await message.reply(confirmationMessage);

            this.userSessions.set(chatId, {
                step: 'confirm_print',
                printJobId: printJob.id,
                lastActivity: Date.now()
            });

            this.log('info', 'Print job created', { 
                jobId: printJob.id, 
                user: userNumber, 
                fileName: printJob.originalName 
            });

        } catch (error) {
            console.error('Error handling file:', error);
            await message.reply('❌ Terjadi kesalahan saat memproses file. Silakan coba lagi.');
            this.log('error', 'File processing error', { user: userNumber, error: error.message });
        }
    }

    async validateFile(media, userNumber) {
        const mimeType = media.mimetype;
        const extension = mime.extension(mimeType);
        const fileSize = Buffer.from(media.data, 'base64').length;

        if (!this.config.printSettings.allowedFormats.includes(`.${extension}`)) {
            this.log('warn', 'Invalid file format', { user: userNumber, extension });
            return {
                valid: false,
                message: `❌ Format file tidak didukung.\n\n📋 Format yang didukung:\n${this.config.printSettings.allowedFormats.join(', ')}`
            };
        }

        if (fileSize > this.config.printSettings.maxFileSize) {
            this.log('warn', 'File too large', { user: userNumber, size: fileSize });
            return {
                valid: false,
                message: `❌ File terlalu besar.\n\n📏 Maksimal: ${(this.config.printSettings.maxFileSize / (1024 * 1024)).toFixed(1)}MB\n📊 Ukuran file: ${(fileSize / (1024 * 1024)).toFixed(1)}MB`
            };
        }

        if (this.config.security.enableFileValidation) {
            const securityCheck = await this.performSecurityCheck(media, extension);
            if (!securityCheck.safe) {
                this.log('warn', 'Security check failed', { user: userNumber, reason: securityCheck.reason });
                return {
                    valid: false,
                    message: '❌ File tidak lolos pemeriksaan keamanan. Silakan gunakan file yang berbeda.'
                };
            }
        }

        return {
            valid: true,
            extension,
            fileSize,
            mimeType
        };
    }

    async performSecurityCheck(media, extension) {
        try {
            const suspiciousPatterns = [
                /javascript:/gi,
                /<script/gi,
                /eval\(/gi,
                /document\.write/gi,
                /\.exe$/gi,
                /\.bat$/gi,
                /\.cmd$/gi
            ];

            const content = Buffer.from(media.data, 'base64').toString();
            
            for (const pattern of suspiciousPatterns) {
                if (pattern.test(content)) {
                    return { safe: false, reason: 'Suspicious content detected' };
                }
            }

            return { safe: true };
        } catch (error) {
            this.log('error', 'Security check error', { error: error.message });
            return { safe: true }; 
        }
    }

    async analyzeFile(filePath, extension) {
        const analysis = {
            pageCount: 1,
            hasColor: false,
            dimensions: null,
            fileInfo: {}
        };

        try {
            if (extension === 'pdf') {
                const pdfBytes = fs.readFileSync(filePath);
                const pdfDoc = await PDFDocument.load(pdfBytes);
                analysis.pageCount = pdfDoc.getPageCount();
                
                analysis.hasColor = await this.detectColorInPDF(pdfBytes);
            } else if (['jpg', 'jpeg', 'png'].includes(extension)) {
                analysis.hasColor = true; 
                analysis.dimensions = await this.getImageDimensions(filePath);
            } else if (['doc', 'docx'].includes(extension)) {
                const stats = fs.statSync(filePath);
                analysis.pageCount = Math.max(1, Math.ceil(stats.size / 50000)); 
            }
        } catch (error) {
            this.log('error', 'File analysis error', { error: error.message });
        }

        return analysis;
    }

    async detectColorInPDF(pdfBytes) {
        const content = pdfBytes.toString();
        return content.includes('DeviceRGB') || content.includes('ColorSpace');
    }

    async getImageDimensions(filePath) {
        return null;
    }

    calculatePrintCost(pageCount, hasColor) {
        const bwCostPerPage = 500; 
        const colorCostPerPage = 2000; 
        
        const costPerPage = hasColor ? colorCostPerPage : bwCostPerPage;
        return pageCount * costPerPage;
    }

    buildConfirmationMessage(printJob, fileAnalysis) {
        const costText = printJob.estimatedCost > 0 
            ? `💰 Estimasi biaya: Rp ${printJob.estimatedCost.toLocaleString('id-ID')}\n`
            : '';

        const colorText = fileAnalysis.hasColor ? '🎨 Warna' : '⚫ Hitam Putih';

        return `
📄 *File Diterima & Dianalisis*

📝 Nama: ${printJob.originalName}
📊 Format: ${printJob.extension.toUpperCase()}
📄 Halaman: ${printJob.pageCount}
💾 Ukuran: ${(printJob.fileSize / 1024).toFixed(1)} KB
🖨️ Salinan: ${printJob.copies}
🎨 Jenis: ${colorText}
${costText}
⏰ Antrian: ${this.printQueue.size} job(s)

*Opsi Print:*
📋 Kertas: ${printJob.printOptions.paperSize}
⚡ Kualitas: ${printJob.printOptions.quality}

Ketik *YA* untuk konfirmasi print
Ketik *BATAL* untuk membatalkan  
Ketik *OPSI* untuk mengatur opsi print`;
    }

    async handleUserResponse(message) {
        const chatId = message.from;
        const session = this.userSessions.get(chatId);
        const response = message.body.toLowerCase().trim();

        if (!session) return;

        switch (session.step) {
            case 'confirm_print':
                if (['ya', 'y', 'yes', 'ok'].includes(response)) {
                    await this.processPrintJob(message, session.printJobId);
                } else if (['batal', 'cancel', 'no', 'tidak'].includes(response)) {
                    await this.cancelPrintJob(message, session.printJobId);
                } else if (['opsi', 'option', 'setting'].includes(response)) {
                    await this.showPrintOptions(message, session.printJobId);
                } else {
                    await message.reply('❌ Respon tidak valid. Ketik *YA*, *BATAL*, atau *OPSI*');
                }
                break;

            case 'set_copies':
                await this.handleCopiesInput(message, response, session.printJobId);
                break;

            case 'set_options':
                await this.handleOptionsInput(message, response, session.printJobId);
                break;
        }
    }

    async showPrintOptions(message, printJobId) {
        const printJob = this.printQueue.get(printJobId);
        const chatId = message.from;

        if (!printJob) {
            await message.reply('❌ Print job tidak ditemukan.');
            return;
        }

        const optionsMessage = `
⚙️ *Opsi Cetak - ${printJob.originalName}*

📋 *Pilihan yang tersedia:*
1️⃣ Ubah jumlah salinan (1-10)
2️⃣ Ubah kualitas (draft/normal/high)  
3️⃣ Ubah ukuran kertas (A4/A3/Letter)
4️⃣ Duplex printing (bolak-balik)
5️⃣ Kembali ke konfirmasi

Ketik nomor pilihan (1-5):`;

        await message.reply(optionsMessage);

        this.userSessions.set(chatId, {
            step: 'set_options',
            printJobId: printJobId,
            lastActivity: Date.now()
        });
    }

    async handleOptionsInput(message, response, printJobId) {
        const printJob = this.printQueue.get(printJobId);
        const chatId = message.from;

        if (!printJob) {
            await message.reply('❌ Print job tidak ditemukan.');
            return;
        }

        switch (response) {
            case '1':
                await message.reply('🔢 Masukkan jumlah salinan (1-10):');
                this.userSessions.set(chatId, {
                    step: 'set_copies',
                    printJobId: printJobId,
                    lastActivity: Date.now()
                });
                break;

            case '2':
                await this.showQualityOptions(message, printJobId);
                break;

            case '3':
                await this.showPaperSizeOptions(message, printJobId);
                break;

            case '4':
                printJob.printOptions.duplex = !printJob.printOptions.duplex;
                await message.reply(`${printJob.printOptions.duplex ? '✅' : '❌'} Duplex printing: ${printJob.printOptions.duplex ? 'ON' : 'OFF'}`);
                await this.showPrintOptions(message, printJobId);
                break;

            case '5':
                await this.showUpdatedConfirmation(message, printJobId);
                break;

            default:
                await message.reply('❌ Pilihan tidak valid. Ketik nomor 1-5.');
        }
    }

    async handleCopiesInput(message, response, printJobId) {
        const copies = parseInt(response);
        const printJob = this.printQueue.get(printJobId);
        const chatId = message.from;

        if (!printJob) {
            await message.reply('❌ Print job tidak ditemukan.');
            return;
        }

        if (isNaN(copies) || copies < 1 || copies > 10) {
            await message.reply('❌ Jumlah salinan harus antara 1-10. Coba lagi:');
            return;
        }

        printJob.copies = copies;
        printJob.estimatedCost = this.calculatePrintCost(printJob.pageCount, printJob.printOptions.color) * copies;

        await message.reply(`✅ Jumlah salinan diubah menjadi: ${copies}`);
        await this.showPrintOptions(message, printJobId);
    }

    async showUpdatedConfirmation(message, printJobId) {
        const printJob = this.printQueue.get(printJobId);
        const chatId = message.from;

        if (!printJob) {
            await message.reply('❌ Print job tidak ditemukan.');
            return;
        }

        const fileAnalysis = { hasColor: printJob.printOptions.color, pageCount: printJob.pageCount };
        const confirmationMessage = this.buildConfirmationMessage(printJob, fileAnalysis);

        await message.reply(confirmationMessage);

        this.userSessions.set(chatId, {
            step: 'confirm_print',
            printJobId: printJobId,
            lastActivity: Date.now()
        });
    }

    async processPrintJob(message, printJobId) {
        const printJob = this.printQueue.get(printJobId);
        const chatId = message.from;
        const userNumber = message.from.replace('@c.us', '');

        if (!printJob) {
            await message.reply('❌ Print job tidak ditemukan.');
            this.userSessions.delete(chatId);
            return;
        }

        try {
            printJob.status = 'printing';
            printJob.startedAt = new Date();

            const processingMsg = await message.reply('🖨️ Memproses print job... Mohon tunggu sebentar.');

            const printerOnline = await this.checkPrinter();
            if (!printerOnline) {
                printJob.status = 'failed';
                await processingMsg.edit('❌ Printer sedang offline atau bermasalah. Silakan coba lagi nanti.');
                this.log('error', 'Printer offline during print job', { jobId: printJobId });
                return;
            }

            await processingMsg.edit('🖨️ Mengirim ke printer... ⏳');

            const success = await this.executePrintWithRetry(printJob, 3);

            if (success) {
                printJob.status = 'completed';
                printJob.completedAt = new Date();

                const userStats = this.userStats.get(userNumber);
                if (userStats) {
                    userStats.totalPrints++;
                    userStats.totalPages += printJob.pageCount * printJob.copies;
                }

                this.printHistory.unshift({
                    ...printJob,
                    completedAt: printJob.completedAt
                });

                if (this.printHistory.length > 100) {
                    this.printHistory = this.printHistory.slice(0, 100);
                }

                const successMessage = this.buildSuccessMessage(printJob);
                await processingMsg.edit(successMessage);

                this.log('info', 'Print job completed successfully', { 
                    jobId: printJobId, 
                    user: userNumber,
                    pages: printJob.pageCount,
                    copies: printJob.copies
                });

            } else {
                printJob.status = 'failed';
                printJob.failedAt = new Date();
                
                await processingMsg.edit(`❌ Print gagal setelah beberapa percobaan.\n\n🔧 Kemungkinan masalah:\n• Printer sedang bermasalah\n• Tinta/toner habis\n• Kertas habis\n• Koneksi printer terputus\n\nSilakan periksa printer dan coba lagi.`);

                this.log('error', 'Print job failed after retries', { 
                    jobId: printJobId, 
                    user: userNumber 
                });
            }

        } catch (error) {
            console.error('Print processing error:', error);
            printJob.status = 'failed';
            await message.reply('❌ Terjadi kesalahan sistem saat mencetak. Silakan coba lagi atau hubungi admin.');
            this.log('error', 'Print processing system error', { 
                jobId: printJobId, 
                user: userNumber, 
                error: error.message 
            });
        }

        this.userSessions.delete(chatId);
        
        setTimeout(() => {
            this.cleanupPrintJob(printJobId);
        }, 300000); 
    }

    buildSuccessMessage(printJob) {
        const duration = printJob.completedAt - printJob.startedAt;
        const durationText = `${Math.round(duration / 1000)} detik`;

        return `
✅ *Print Berhasil!*

📄 File: ${printJob.originalName}
🖨️ Halaman: ${printJob.pageCount} x ${printJob.copies} salinan
📊 Total halaman: ${printJob.pageCount * printJob.copies}
⏱️ Waktu proses: ${durationText}
⏰ Selesai: ${printJob.completedAt.toLocaleString('id-ID')}

🎯 Silakan ambil dokumen Anda di printer.

💡 Tips: Gunakan /history untuk melihat riwayat print Anda.`;
    }

    async executePrintWithRetry(printJob, maxRetries) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            this.log('info', `Print attempt ${attempt}/${maxRetries}`, { jobId: printJob.id });
            
            const success = await this.executePrint(printJob);
            if (success) {
                return true;
            }

            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 2000)); 
            }
        }
        return false;
    }

    async executePrint(printJob) {
        return new Promise((resolve) => {
            let printCommand;
            const options = printJob.printOptions;

            if (process.platform === 'win32') {
                let psCommand = `Start-Process -FilePath '${printJob.filePath}' -Verb Print -Wait`;
                printCommand = `powershell -Command "${psCommand}"`;
            } else if (process.platform === 'darwin') {
                let lprOptions = [
                    `-P ${this.config.printSettings.printerName}`,
                    `-# ${printJob.copies}`
                ];
                
                if (options.duplex) lprOptions.push('-o sides=two-sided-long-edge');
                if (options.paperSize !== 'A4') lprOptions.push(`-o media=${options.paperSize}`);
                
                printCommand = `lpr ${lprOptions.join(' ')} "${printJob.filePath}"`;
            } else {
                let lprOptions = [
                    `-P ${this.config.printSettings.printerName}`,
                    `-# ${printJob.copies}`
                ];
                
                if (options.duplex) lprOptions.push('-o sides=two-sided-long-edge');
                if (options.quality === 'draft') lprOptions.push('-o print-quality=3');
                if (options.quality === 'high') lprOptions.push('-o print-quality=5');
                
                printCommand = `lpr ${lprOptions.join(' ')} "${printJob.filePath}"`;
            }

            this.log('info', 'Executing print command', { command: printCommand, jobId: printJob.id });

            exec(printCommand, { timeout: 30000 }, (error, stdout, stderr) => {
                if (error) {
                    this.log('error', 'Print command failed', { 
                        error: error.message, 
                        stderr, 
                        jobId: printJob.id 
                    });
                    resolve(false);
                } else {
                    this.log('info', 'Print command successful', { 
                        stdout, 
                        jobId: printJob.id 
                    });
                    resolve(true);
                }
            });
        });
    }

    async checkPrinter() {
        return new Promise((resolve) => {
            let command;
            
            if (process.platform === 'win32') {
                command = `powershell -Command "Get-Printer | Where-Object {$_.PrinterStatus -eq 'Normal'}"`;
            } else {
                command = `lpstat -p ${this.config.printSettings.printerName}`;
            }

            exec(command, (error, stdout, stderr) => {
                const isOnline = !error && stdout.includes('idle') || stdout.includes('Normal');
                this.printerStatus = { online: isOnline, lastCheck: Date.now() };
                resolve(isOnline);
            });
        });
    }

    async sendBotStats(message) {
        const uptime = process.uptime();
        const uptimeHours = Math.floor(uptime / 3600);
        const uptimeMinutes = Math.floor((uptime % 3600) / 60);

        const totalJobs = this.printHistory.length + this.printQueue.size;
        const completedJobs = this.printHistory.filter(job => job.status === 'completed').length;
        const failedJobs = this.printHistory.filter(job => job.status === 'failed').length;
        const totalPages = this.printHistory.reduce((sum, job) => sum + (job.pageCount * job.copies), 0);

        const statsMessage = `
📊 *Statistik Bot (Admin)*

⏱️ **Uptime:** ${uptimeHours}h ${uptimeMinutes}m
🖨️ **Printer:** ${this.printerStatus.online ? '🟢 Online' : '🔴 Offline'}
📋 **Total Jobs:** ${totalJobs}
✅ **Berhasil:** ${completedJobs}
❌ **Gagal:** ${failedJobs}
📄 **Total Halaman:** ${totalPages.toLocaleString('id-ID')}
👥 **Active Users:** ${this.userStats.size}
📋 **Antrian Aktif:** ${this.printQueue.size}

💾 **Memory Usage:** ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB
🔄 **Success Rate:** ${totalJobs > 0 ? Math.round((completedJobs / totalJobs) * 100) : 0}%

⏰ Last Check: ${new Date().toLocaleString('id-ID')}`;

        await message.reply(statsMessage);
    }

    async sendUserStats(message) {
        const sortedUsers = Array.from(this.userStats.entries())
            .sort((a, b) => b[1].totalPrints - a[1].totalPrints)
            .slice(0, 10);

        let userStatsMessage = '👥 *Top 10 Users:*\n\n';

        sortedUsers.forEach(([userNumber, stats], index) => {
            const userName = userNumber.substring(0, 4) + '****' + userNumber.substring(userNumber.length - 2);
            userStatsMessage += `${index + 1}. ${userName}\n`;
            userStatsMessage += `   🖨️ ${stats.totalPrints} prints • 📄 ${stats.totalPages} pages\n`;
            userStatsMessage += `   📅 Last: ${new Date(stats.lastSeen).toLocaleDateString('id-ID')}\n\n`;
        });

        await message.reply(userStatsMessage);
    }

    async sendDetailedQueue(message) {
        const jobs = Array.from(this.printQueue.values())
            .sort((a, b) => a.createdAt - b.createdAt);

        if (jobs.length === 0) {
            await message.reply('📋 Antrian kosong.');
            return;
        }

        let queueMessage = `📋 *Detail Antrian (${jobs.length} jobs):*\n\n`;

        jobs.forEach((job, index) => {
            const statusEmoji = {
                'pending': '⏳',
                'printing': '🖨️',
                'completed': '✅',
                'failed': '❌'
            };

            const userName = job.userNumber.substring(0, 4) + '****';
            const timeAgo = Math.round((Date.now() - job.createdAt.getTime()) / 1000 / 60);

            queueMessage += `${index + 1}. ${statusEmoji[job.status]} ${job.originalName}\n`;
            queueMessage += `   👤 ${userName} • 📄 ${job.pageCount}p • 🖨️ ${job.copies}x\n`;
            queueMessage += `   ⏰ ${timeAgo}m ago • ${job.status.toUpperCase()}\n\n`;
        });

        await message.reply(queueMessage);
    }

    async checkPrinterStatus(message) {
        await message.reply('🔍 Memeriksa status printer...');
        
        const isOnline = await this.checkPrinter();
        
        const statusMessage = `
🖨️ *Status Printer*

🏷️ **Nama:** ${this.config.printSettings.printerName}
📊 **Status:** ${isOnline ? '🟢 Online & Ready' : '🔴 Offline/Error'}
⏰ **Last Check:** ${new Date(this.printerStatus.lastCheck).toLocaleString('id-ID')}

${isOnline ? '✅ Printer siap menerima print job.' : '❌ Periksa koneksi printer dan pastikan sudah menyala.'}`;

        await message.reply(statusMessage);
    }

    async testPrint(message) {
        try {
            const testContent = `
WhatsApp Print Server - Test Print
===================================

Tanggal: ${new Date().toLocaleString('id-ID')}
Admin: ${message.from.replace('@c.us', '')}

Test berhasil jika Anda dapat membaca teks ini.

✅ Koneksi printer: OK
✅ Sistem print: OK  
✅ Bot WhatsApp: OK

---
Powered by Enhanced WhatsApp Print Bot
            `;

            const testFilePath = path.join(__dirname, 'temp', `test_print_${Date.now()}.txt`);
            fs.writeFileSync(testFilePath, testContent);

            const testJob = {
                id: 'test_' + Date.now(),
                fileName: 'test_print.txt',
                filePath: testFilePath,
                extension: 'txt',
                pageCount: 1,
                copies: 1,
                printOptions: {
                    duplex: false,
                    paperSize: 'A4',
                    quality: 'normal'
                }
            };

            await message.reply('🖨️ Mengirim test print...');

            const success = await this.executePrint(testJob);

            if (success) {
                await message.reply('✅ Test print berhasil! Periksa printer untuk hasil cetakan.');
                this.log('info', 'Test print successful', { admin: message.from });
            } else {
                await message.reply('❌ Test print gagal. Periksa konfigurasi printer.');
                this.log('error', 'Test print failed', { admin: message.from });
            }

            setTimeout(() => {
                if (fs.existsSync(testFilePath)) {
                    fs.unlinkSync(testFilePath);
                }
            }, 5000);

        } catch (error) {
            await message.reply('❌ Error saat test print: ' + error.message);
            this.log('error', 'Test print error', { error: error.message });
        }
    }

    async sendConfigInfo(message) {
        const configInfo = `
⚙️ *Konfigurasi Bot*

🖨️ **Print Settings:**
• Printer: ${this.config.printSettings.printerName}
• Max File Size: ${(this.config.printSettings.maxFileSize / 1024 / 1024).toFixed(1)}MB
• Default Copies: ${this.config.printSettings.defaultCopies}
• Auto Cleanup: ${this.config.printSettings.autoCleanup ? '✅' : '❌'}

👥 **Access Control:**
• Allowed Users: ${this.config.printSettings.allowedUsers.length || 'All'}
• Admin Numbers: ${this.config.bot.adminNumbers.length}

🔒 **Security:**
• Rate Limit: ${this.config.security.enableRateLimit ? '✅' : '❌'}
• Max Requests/Hour: ${this.config.security.maxRequestsPerHour}
• File Validation: ${this.config.security.enableFileValidation ? '✅' : '❌'}

📋 **Formats:** ${this.config.printSettings.allowedFormats.join(', ')}

📝 Edit config.json untuk mengubah pengaturan.`;

        await message.reply(configInfo);
    }

    async sendRecentLogs(message) {
        try {
            if (!fs.existsSync(this.logFile)) {
                await message.reply('📝 Belum ada log file untuk hari ini.');
                return;
            }

            const logContent = fs.readFileSync(this.logFile, 'utf8');
            const lines = logContent.split('\n').filter(line => line.trim());
            const recentLines = lines.slice(-20); 

            let logMessage = '📝 *Log Terbaru (20 entries):*\n\n';
            
            recentLines.forEach(line => {
                if (line.includes('ERROR')) {
                    logMessage += `❌ ${line.substring(0, 100)}...\n`;
                } else if (line.includes('WARN')) {
                    logMessage += `⚠️ ${line.substring(0, 100)}...\n`;
                } else {
                    logMessage += `ℹ️ ${line.substring(0, 100)}...\n`;
                }
            });

            await message.reply(logMessage);

        } catch (error) {
            await message.reply('❌ Error membaca log: ' + error.message);
        }
    }

    async broadcastMessage(messageText) {
        const activeUsers = Array.from(this.userStats.keys())
            .filter(userNumber => {
                const stats = this.userStats.get(userNumber);
                const daysSinceLastSeen = (Date.now() - stats.lastSeen) / (1000 * 60 * 60 * 24);
                return daysSinceLastSeen <= 7; 
            });

        const broadcastText = `
📢 *Broadcast dari Admin*

${messageText}

---
WhatsApp Print Server Bot`;

        for (const userNumber of activeUsers) {
            try {
                const chatId = userNumber + '@c.us';
                await this.client.sendMessage(chatId, broadcastText);
                await new Promise(resolve => setTimeout(resolve, 1000)); 
            } catch (error) {
                this.log('error', 'Broadcast failed for user', { user: userNumber, error: error.message });
            }
        }

        this.log('info', 'Broadcast completed', { recipients: activeUsers.length });
    }

    async sendUserHistory(message, userNumber) {
        const userHistory = this.printHistory
            .filter(job => job.userNumber === userNumber)
            .slice(0, 10);

        if (userHistory.length === 0) {
            await message.reply('📋 Anda belum memiliki riwayat print.');
            return;
        }

        let historyMessage = `📚 *Riwayat Print Anda (${userHistory.length} terakhir):*\n\n`;

        userHistory.forEach((job, index) => {
            const statusEmoji = job.status === 'completed' ? '✅' : '❌';
            const date = job.completedAt ? job.completedAt.toLocaleDateString('id-ID') : job.createdAt.toLocaleDateString('id-ID');
            
            historyMessage += `${index + 1}. ${statusEmoji} ${job.originalName}\n`;
            historyMessage += `   📄 ${job.pageCount} hal • 🖨️ ${job.copies}x • ${date}\n\n`;
        });

        const userStats = this.userStats.get(userNumber);
        if (userStats) {
            historyMessage += `📊 **Total Statistik:**\n`;
            historyMessage += `🖨️ Total Print: ${userStats.totalPrints}\n`;
            historyMessage += `📄 Total Halaman: ${userStats.totalPages}`;
        }

        await message.reply(historyMessage);
    }

    async sendSupportedFormats(message) {
        const formatsInfo = `
📋 *Format File yang Didukung*

📄 **Dokumen:**
• PDF (.pdf) - Paling direkomendasikan
• Microsoft Word (.doc, .docx)
• Plain Text (.txt)

🖼️ **Gambar:**
• JPEG (.jpg, .jpeg)
• PNG (.png)

⚙️ **Spesifikasi:**
• Ukuran maksimal: ${(this.config.printSettings.maxFileSize / 1024 / 1024).toFixed(1)}MB
• Kualitas print: Draft, Normal, High
• Ukuran kertas: A4, A3, Letter
• Duplex printing: Tersedia

💡 **Tips:**
• Gunakan PDF untuk hasil terbaik
• Pastikan file tidak ter-password
• Kompres gambar besar sebelum kirim
• Periksa orientasi dokumen (portrait/landscape)

📏 **Estimasi Halaman:**
• PDF: Deteksi otomatis
• Word: Berdasarkan ukuran file
• Gambar: 1 halaman per file
• Text: Berdasarkan panjang konten`;

        await message.reply(formatsInfo);
    }

    async sendHelpMessage(message) {
        const userNumber = message.from.replace('@c.us', '');
        const isAdmin = this.isAdmin(userNumber);

        let helpMessage = `
🤖 *Enhanced WhatsApp Print Server*

📄 **Cara Pakai:**
1️⃣ Kirim file (PDF, DOC, JPG, PNG, TXT)
2️⃣ Bot analisis file & tampilkan info
3️⃣ Konfirmasi dengan ketik *YA*
4️⃣ Tunggu notifikasi print selesai

⚙️ **Commands User:**
• /help - Bantuan lengkap
• /status - Status printer & sistem
• /queue - Antrian print saat ini  
• /cancel - Batalkan print job
• /history - Riwayat print Anda
• /formats - Format file yang didukung
• /ping - Test koneksi bot

📋 **Format Didukung:**
${this.config.printSettings.allowedFormats.join(' • ')}

📏 **Batas:** ${(this.config.printSettings.maxFileSize / 1024 / 1024).toFixed(1)}MB per file

🎯 **Fitur Canggih:**
✅ Deteksi halaman otomatis
✅ Analisis warna dokumen  
✅ Estimasi biaya print
✅ Opsi print (duplex, kualitas, kertas)
✅ Antrian & prioritas
✅ Riwayat & statistik
✅ Rate limiting & keamanan

`;

        if (isAdmin) {
            helpMessage += `
👑 **Admin Commands:**
• /admin stats - Statistik sistem
• /admin users - Data pengguna
• /admin queue - Detail antrian
• /admin printer check - Cek printer
• /admin printer test - Test print
• /admin config - Info konfigurasi
• /admin logs - Log sistem
• /admin broadcast <msg> - Broadcast

`;
        }

        helpMessage += `🖨️ *Siap melayani print request Anda!*`;

        await message.reply(helpMessage);
    }

    cleanupPrintJob(printJobId) {
        const printJob = this.printQueue.get(printJobId);
        if (printJob) {
            try {
                if (fs.existsSync(printJob.filePath)) {
                    fs.unlinkSync(printJob.filePath);
                    this.log('info', 'Temp file deleted', { file: printJob.filePath });
                }
                
                this.printQueue.delete(printJobId);
                this.log('info', 'Print job cleaned up', { jobId: printJobId });
                
            } catch (error) {
                this.log('error', 'Cleanup error', { jobId: printJobId, error: error.message });
            }
        }
    }

    startPeriodicTasks() {
        setInterval(() => {
            this.cleanupOldSessions();
        }, 5 * 60 * 1000);

        setInterval(() => {
            this.cleanupOldPrintJobs();
        }, 30 * 60 * 1000);

        setInterval(() => {
            this.checkPrinter();
        }, 10 * 60 * 1000);

        setInterval(() => {
            this.saveStats();
        }, 60 * 60 * 1000);

        setInterval(() => {
            this.rotateLogs();
        }, 24 * 60 * 60 * 1000);
    }

    cleanupOldSessions() {
        const now = Date.now();
        const timeout = 15 * 60 * 1000; 

        let cleaned = 0;
        for (const [chatId, session] of this.userSessions) {
            if (now - session.lastActivity > timeout) {
                this.userSessions.delete(chatId);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            this.log('info', 'Old sessions cleaned', { count: cleaned });
        }
    }

    cleanupOldPrintJobs() {
        const now = Date.now();
        const maxAge = 60 * 60 * 1000; 
        
        let cleaned = 0;
        for (const [jobId, job] of this.printQueue) {
            if (now - job.createdAt.getTime() > maxAge && 
                (job.status === 'completed' || job.status === 'failed')) {
                this.cleanupPrintJob(jobId);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            this.log('info', 'Old print jobs cleaned', { count: cleaned });
        }
    }

    saveStats() {
        try {
            const statsFile = path.join(__dirname, 'logs', 'stats.json');
            const stats = {
                userStats: Array.from(this.userStats.entries()),
                printHistory: this.printHistory.slice(0, 1000), 
                systemStats: {
                    totalJobs: this.printHistory.length,
                    uptime: process.uptime(),
                    memoryUsage: process.memoryUsage(),
                    timestamp: Date.now()
                }
            };

            fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2));
            this.log('info', 'Stats saved successfully');

        } catch (error) {
            this.log('error', 'Failed to save stats', { error: error.message });
        }
    }

    rotateLogs() {
        try {
            const logDir = path.join(__dirname, 'logs');
            const files = fs.readdirSync(logDir)
                .filter(file => file.startsWith('bot-') && file.endsWith('.log'))
                .sort();

            if (files.length > 30) {
                const oldFiles = files.slice(0, files.length - 30);
                oldFiles.forEach(file => {
                    fs.unlinkSync(path.join(logDir, file));
                });
                this.log('info', 'Old logs rotated', { removed: oldFiles.length });
            }

        } catch (error) {
            this.log('error', 'Log rotation failed', { error: error.message });
        }
    }

    async start() {
        console.log('🚀 Memulai Enhanced WhatsApp Print Server Bot...');
        console.log('===============================================');
        console.log(`📊 Konfigurasi dimuat: ${this.configPath}`);
        console.log(`🖨️ Printer default: ${this.config.printSettings.printerName}`);
        console.log(`👥 Admin numbers: ${this.config.bot.adminNumbers.length}`);
        console.log(`🔒 Security enabled: ${this.config.security.enableRateLimit}`);
        console.log('===============================================');
        
        this.log('info', 'Enhanced WhatsApp Print Bot started', {
            config: this.config,
            version: '2.0.0',
            platform: process.platform
        });
    }

    async shutdown() {
        console.log('🛑 Shutting down bot...');
        
        try {
            this.saveStats();
            
            this.printQueue.clear();
            this.userSessions.clear();
            
            await this.client.destroy();
            
            this.log('info', 'Bot shutdown completed');
            console.log('✅ Bot shutdown completed.');
            
        } catch (error) {
            console.error('Error during shutdown:', error);
            this.log('error', 'Shutdown error', { error: error.message });
        }
        
        process.exit(0);
    }
}

process.on('SIGINT', async () => {
    if (global.botInstance) {
        await global.botInstance.shutdown();
    } else {
        process.exit(0);
    }
});

process.on('SIGTERM', async () => {
    if (global.botInstance) {
        await global.botInstance.shutdown();
    } else {
        process.exit(0);
    }
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    if (global.botInstance) {
        global.botInstance.log('error', 'Uncaught exception', { error: error.message, stack: error.stack });
    }
    process.exit(1);
});

const enhancedBot = new EnhancedWhatsAppPrintBot();
global.botInstance = enhancedBot;
enhancedBot.start();

module.exports = EnhancedWhatsAppPrintBot;