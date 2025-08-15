// steam-id-processor/src/test-socks-proxy.js 
const { SocksProxyAgent } = require('socks-proxy-agent');
const https = require('https');

async function testSteamWithProxy() {
    // Your proxy configuration
    const proxyUrl = 'socks5://kpnpn:NJkdkqw1@45.11.21.12:5501';
    const agent = new SocksProxyAgent(proxyUrl);
    
    const steamUrl = 'https://steamcommunity.com/inventory/76561198009443776/730/2';
    
    const options = {
        agent: agent,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
    };
    
    console.log('Testing Steam Community request through SOCKS5 proxy...');
    
    try {
        const req = https.request(steamUrl, options, (res) => {
            console.log(`✅ Response status: ${res.statusCode}`);
            console.log(`Response headers:`, res.headers);
            
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                console.log('\n--- Response body (first 500 characters) ---');
                console.log(data.substring(0, 500));
                
                if (data.includes('"assets":[')) {
                    console.log('\n✅ Successfully received Steam inventory data!');
                } else {
                    console.log('\n⚠️ Response received but may not be inventory data');
                }
            });
        });
        
        req.on('error', (error) => {
            console.log('❌ Request failed:');
            console.log(error.message);
        });
        
        req.setTimeout(10000, () => {
            console.log('❌ Request timed out');
            req.destroy();
        });
        
        req.end();
        
    } catch (error) {
        console.log('❌ Error setting up request:');
        console.log(error.message);
    }
}

testSteamWithProxy();