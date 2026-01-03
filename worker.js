const io = require("socket.io-client");
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// --- কনফিগারেশন ---
// 🔥 আপনার Render সার্ভারের লিংকটি এখানে বসান (যেমন: https://my-app.onrender.com)
const SERVER_URL = "http://localhost:3000"; 

const CONFIG_PATH = path.join(__dirname, 'config.json');
const LOGIC_PATH = path.join(__dirname, 'logic.js');

// ==================================================
// 1. অটোমেটিক ফাইল জেনারেটর (Config & Logic)
// ==================================================

// ক) Config.json না থাকলে তৈরি করা
if (!fs.existsSync(CONFIG_PATH)) {
    console.log("⚙️ No config found. Generating new identity...");
    
    // ইউনিক মেশিন নাম তৈরি (পিসির নাম + র‍্যান্ডম কোড)
    const pcName = os.hostname().replace(/[^a-zA-Z0-9]/g, '-');
    const randomId = crypto.randomBytes(2).toString('hex');
    const newMachineId = `${pcName}-${randomId}`.toUpperCase();
    
    // র‍্যান্ডম সিক্রেট কী
    const newSecretKey = crypto.randomBytes(16).toString('hex');

    const newConfig = { machineId: newMachineId, secretKey: newSecretKey };

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2));
    console.log(`✅ Config created! Machine ID: ${newMachineId}`);
}

// খ) Logic.js না থাকলে ফাঁকা ফাইল তৈরি করা
if (!fs.existsSync(LOGIC_PATH)) {
    console.log("⚠️ logic.js missing. Creating placeholder...");
    fs.writeFileSync(LOGIC_PATH, "// Waiting for server update..."); 
    console.log("✅ Placeholder logic.js created. Will download real code from server soon.");
}

// ==================================================
// 2. মডিউল লোডিং সিস্টেম
// ==================================================

// কনফিগ লোড
let config;
try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (e) {
    console.error("❌ Config corrupted. Delete config.json and restart.");
    process.exit(1);
}

// লজিক লোড করার ফাংশন (Hot Reload সহ)
let logic;
function loadLogic() {
    try {
        if (fs.existsSync(LOGIC_PATH)) {
            // ক্যাশ থেকে মুছে ফেলা (যাতে নতুন কোড লোড হয়)
            delete require.cache[require.resolve(LOGIC_PATH)];
            logic = require(LOGIC_PATH);
            
            // লজিক ফাইলটি ভ্যালিড কিনা চেক করা
            if (logic && logic.processBatch) {
                console.log("✅ Logic module loaded successfully.");
                return true;
            }
        }
    } catch (e) {
        console.log("⚠️ Logic file exists but is not ready yet.");
    }
    return false;
}
loadLogic(); // প্রথমবার চেষ্টা

// বর্তমান ফাইলের হাশ (Hash) বের করা
function getLocalHash() {
    try {
        if (!fs.existsSync(LOGIC_PATH)) return null;
        const fileBuffer = fs.readFileSync(LOGIC_PATH);
        const hashSum = crypto.createHash('md5');
        hashSum.update(fileBuffer);
        return hashSum.digest('hex');
    } catch (e) { return null; }
}

// ==================================================
// 3. সার্ভার কানেকশন
// ==================================================

console.log(`🔌 Connecting to ${SERVER_URL} as ${config.machineId}...`);

const socket = io(SERVER_URL, {
    auth: {
        machineId: config.machineId,
        secretKey: config.secretKey
    },
    query: { type: 'worker', name: config.machineId }
});

// --- কানেকশন ইভেন্ট ---
socket.on('connect', () => {
    console.log("🟢 Connected to Server!");
    
    // সার্ভারকে আমার বর্তমান লজিক ফাইলের হাশ পাঠানো
    socket.emit('check_version', getLocalHash());
    
    // হার্টবিট
    setInterval(() => socket.emit('heartbeat'), 10000);
});

socket.on('connect_error', (err) => {
    console.log(`🔴 Connection Failed: ${err.message}`);
});

// --- আপডেট রিসিভ করা ---
socket.on('update_logic_file', (data) => {
    console.log("📥 Downloading new logic file from server...");
    try {
        fs.writeFileSync(LOGIC_PATH, data.content);
        console.log("💾 File saved. Reloading logic...");
        loadLogic(); 
        console.log("🚀 Ready for tasks!");
    } catch (e) {
        console.error("❌ Update failed:", e.message);
    }
});

socket.on('logic_uptodate', () => {
    console.log("✅ Client logic is up to date.");
});

// ==================================================
// 4. টাস্ক প্রসেসিং (Main Work)
// ==================================================
socket.on('execute_task', async (data) => {
    // লজিক লোড না থাকলে অপেক্ষা করুন
    if (!logic || !logic.processBatch) {
        console.log("⏳ Logic not ready. Waiting for download...");
        socket.emit('check_version', getLocalHash());
        return;
    }

    const { requestId, taskType, payload } = data;
    console.log(`🚀 Processing Task: ${taskType} | ID: ${requestId.substring(0,6)}...`);

    // প্রোগ্রেস পাঠানোর কলব্যাক
    const sendProgress = (progressData) => {
        process.stdout.write(`\r⏳ Meter: ${progressData.current}/${progressData.total} | Status: ${progressData.status}   `);
        socket.emit('task_progress', { requestId, progress: progressData });
    };

    let result;
    try {
        switch (taskType) {
            case 'METER_POST':
            case 'FAST_POST':
                result = await logic.processBatch(payload.userid, payload.password, payload.meters, sendProgress);
                break;
            
            case 'LOGIN_CHECK':
                result = await logic.verifyLoginDetails(payload.userid, payload.password);
                break;

            case 'INVENTORY':
                // 🔥 FIXED: ইনভেন্টরি চেক করার আগে লগইন করা বাধ্যতামূলক
                console.log("🔍 Logging in to fetch inventory...");
                const authInv = await logic.verifyLoginDetails(payload.userid, payload.password);
                
                if (!authInv.success) {
                    console.log("❌ Login Failed");
                    result = { error: "Login Failed: " + authInv.message };
                } else {
                    console.log("✅ Login Success. Fetching meter list...");
                    const data = await logic.getInventoryList(authInv.cookies, payload.limit || 50);
                    console.log(`📦 Found ${data.length} meters.`);
                    result = { status: "success", count: data.length, data: data };
                }
                break;

            case 'SINGLE_CHECK':
                const auth = await logic.verifyLoginDetails(payload.userid, payload.password);
                if (!auth.success) {
                    result = { error: "Login Failed" };
                } else {
                    const check = await logic.verifyMeter(auth.cookies, payload.meterNo);
                    result = check.found ? { status: "found", data: check.data } : { status: "not_found" };
                }
                break;

            default:
                result = { error: "Unknown Task Type" };
        }
    } catch (e) {
        console.error(`\n❌ Error: ${e.message}`);
        result = { error: e.message, failed: 1 };
    }

    console.log(`\n✅ Task Finished.`);
    socket.emit('task_completed', { requestId, result });
});