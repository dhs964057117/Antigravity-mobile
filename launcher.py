import sys
import subprocess
import time
import random
import string
import os
import socket
import argparse
import logging

if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

# -----------------------------------------------------------------------------
# Dependency Management
# -----------------------------------------------------------------------------
def check_dependencies():
    """Checks and installs required Python packages."""
    needed = ["python-dotenv", "qrcode", "Pillow"]
    installed = []
    
    # Check what is missing
    for pkg in needed:
        try:
            if pkg == "python-dotenv": from dotenv import load_dotenv
            elif pkg == "qrcode": import qrcode
            elif pkg == "Pillow": import PIL
            installed.append(pkg)
        except ImportError:
            pass

    missing = [pkg for pkg in needed if pkg not in installed]
    
    if missing:
        print(f"📦 Installing missing dependencies: {', '.join(missing)}...", flush=True)
        try:
            cmd = [sys.executable, "-m", "pip", "install", "-i", "https://pypi.tuna.tsinghua.edu.cn/simple", "--trusted-host", "pypi.tuna.tsinghua.edu.cn"] + missing
            subprocess.check_call(cmd)
            print("✅ Dependencies installed.\n", flush=True)
        except Exception as e:
            print(f"❌ Failed to install dependencies: {e}", flush=True)
            sys.exit(1)

def check_node_environment():
    """Checks for Node.js and installs npm dependencies if needed."""
    # 1. Check if Node is installed
    try:
        subprocess.check_call(["node", "--version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except (FileNotFoundError, subprocess.CalledProcessError):
        print("❌ Error: Node.js is not installed. Please install it from https://nodejs.org/")
        sys.exit(1)

    # 2. Check for node_modules
    if not os.path.exists("node_modules"):
        print("📦 'node_modules' missing. Installing Node.js dependencies...")
        try:
            # shell=True often needed on Windows for npm. On *nix, 'npm' usually works directly if in PATH.
            is_windows = sys.platform == "win32"
            subprocess.check_call(["npm", "install"], shell=is_windows)
            print("✅ Node dependencies installed.\n")
        except Exception as e:
            print(f"❌ Failed to run 'npm install': {e}")
            sys.exit(1)

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------
def get_local_ip():
    """Robustly determines the local LAN IP address."""
    if os.environ.get('LOCAL_IP'):
        return os.environ.get('LOCAL_IP')
    try:
        # Check all available IPv4 addresses
        ips = [ip[4][0] for ip in socket.getaddrinfo(socket.gethostname(), None) if ':' not in ip[4][0]]
        # Filter out loopback, link-local, and VPN/Clash TUN fake-ips (198.18.x.x)
        valid_ips = [ip for ip in ips if not (ip.startswith('127.') or ip.startswith('169.254.') or ip.startswith('198.18.'))]
        # Prioritize real LAN IPs (192.168.x.x excluding 192.168.137.x hotspot if another exists)
        non_hotspot = [ip for ip in valid_ips if not ip.startswith('192.168.137.')]
        if non_hotspot:
            return non_hotspot[0]
        if valid_ips:
            return valid_ips[0]
    except Exception:
        pass
    s = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        IP = s.getsockname()[0]
    except Exception:
        IP = '127.0.0.1'
    finally:
        if s:
            s.close()
    return IP

def generate_passcode():
    """Generates a 6-digit passcode."""
    return ''.join(random.choices(string.digits, k=6))

def print_qr(url):
    """Generates and prints a QR code to the terminal, and saves a crisp image."""
    import qrcode
    # 1. Save crisp PNG with standard quiet zone border
    try:
        img_qr = qrcode.QRCode(version=1, box_size=10, border=4)
        img_qr.add_data(url)
        img_qr.make(fit=True)
        img = img_qr.make_image(fill_color="black", back_color="white")
        qr_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "qrcode.png")
        img.save(qr_path)
        print(f"🖼️  Saved scannable QR image -> {qr_path}")
        if sys.platform == "win32":
            try:
                os.startfile(qr_path)
            except Exception:
                pass
    except Exception:
        pass

    # 2. Terminal ASCII printing with border
    try:
        qr = qrcode.QRCode(version=1, box_size=1, border=2)
        qr.add_data(url)
        qr.make(fit=True)
        qr.print_ascii(invert=True)
    except Exception:
        pass

# -----------------------------------------------------------------------------
# Main Execution
# -----------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="Antigravity Phone Connect Launcher")
    parser.add_argument('--mode', choices=['local', 'web'], default='web', help="Mode to run in: 'local' (WiFi) or 'web' (Internet)")
    parser.add_argument('--provider', choices=['ngrok', 'cloudflare', 'pinggy'], help="Tunnel provider (defaults to .env TUNNEL_PROVIDER or 'ngrok')")
    args = parser.parse_args()

    # 1. Setup Environment
    check_dependencies()
    check_node_environment()
    
    from dotenv import load_dotenv

    # Load .env if it exists
    load_dotenv()

    # Determine Provider
    provider = args.provider or os.environ.get('TUNNEL_PROVIDER', 'ngrok').lower()

    if provider == 'ngrok':
        try:
            from pyngrok import ngrok
            logging.getLogger("pyngrok").setLevel(logging.ERROR)
        except ImportError:
            pass
    
    # Setup App Password
    passcode = os.environ.get('APP_PASSWORD')
    if not passcode:
        passcode = generate_passcode()
        os.environ['APP_PASSWORD'] = passcode # Set for child process
        print(f"⚠️  No APP_PASSWORD in .env. Using temporary: {passcode}", flush=True)

    # 2. Start Node.js Server (Common to both modes)
    print(f"🚀 Starting Antigravity Server ({args.mode.upper()} mode)...", flush=True)
    
    # Clean up old logs
    with open("server_log.txt", "w") as f:
        f.write(f"--- Server Started at {time.ctime()} ---\n")

    node_cmd = ["node", "server.js"]
    node_process = None
    
    try:
        # Redirect stdout/stderr to file
        log_file = open("server_log.txt", "a")
        if sys.platform == "win32":
            # On Windows, using shell=True can help with path resolution but makes killing harder.
            # We'll use shell=False and rely on PATH.
            node_process = subprocess.Popen(node_cmd, stdout=log_file, stderr=log_file, env=os.environ.copy())
        else:
            node_process = subprocess.Popen(node_cmd, stdout=log_file, stderr=log_file, env=os.environ.copy())
            
        time.sleep(2) # Give it a moment to crash if it's going to
        if node_process.poll() is not None:
            print("❌ Server failed to start immediately. Check server_log.txt.")
            sys.exit(1)
            
    except Exception as e:
        print(f"❌ Failed to launch node: {e}")
        sys.exit(1)

    # 3. Mode Specific Logic
    final_url = ""
    
    try:
        if args.mode == 'local':
            ip = get_local_ip()
            port = os.environ.get('PORT', '3000')
            
            # Detect HTTPS
            protocol = "http"
            if os.path.exists('certs/server.key') and os.path.exists('certs/server.cert'):
                protocol = "https"
            
            final_url = f"{protocol}://{ip}:{port}"
            
            print("\n" + "="*50)
            print(f"📡 LOCAL WIFI ACCESS")
            print("="*50)
            print(f"🔗 URL: {final_url}")
            print(f"🔑 Passcode: Not required for local WiFi (Auto-detected)")
            
            print("\n📱 Scan this QR Code to connect:")
            print_qr(final_url)

            print("-" * 50)
            print("📝 Steps to Connect:")
            print("1. Ensure your phone is on the SAME Wi-Fi network as this computer.")
            print("2. Open your phone's Camera app or a QR scanner.")
            print("3. Scan the code above OR manually type the URL into your browser.")
            print("4. You should be connected automatically!")
            
        elif args.mode == 'web':
            port = os.environ.get('PORT', '3000')
            
            # Detect HTTPS
            protocol = "http"
            if os.path.exists('certs/server.key') and os.path.exists('certs/server.cert'):
                protocol = "https"
                
            addr = f"{protocol}://localhost:{port}"
            public_url = ""

            if provider == 'pinggy':
                print("PLEASE WAIT... Establishing Pinggy Tunnel...")
                try:
                    import pinggy
                    pinggy_token = os.environ.get('PINGGY_TOKEN')  # Optional: for persistent subdomain
                    pinggy_tunnel = pinggy.start_tunnel(
                        forwardto=f"localhost:{port}",
                        token=pinggy_token if pinggy_token else None,
                        localservertls=(protocol == "https")
                    )
                    # Prefer HTTPS URL from the returned list
                    tunnel_urls = pinggy_tunnel.urls if hasattr(pinggy_tunnel, 'urls') else []
                    public_url = next((u for u in tunnel_urls if u.startswith('https://')), None)
                    if not public_url and tunnel_urls:
                        public_url = tunnel_urls[0]  # fallback to first URL
                    if not public_url:
                        print("❌ Failed to obtain a Pinggy URL.")
                        sys.exit(1)
                except ImportError:
                    print("❌ Error: 'pinggy' package not found. Run: pip install pinggy")
                    sys.exit(1)
                except Exception as e:
                    print(f"❌ Failed to start Pinggy Tunnel: {e}")
                    sys.exit(1)

            elif provider == 'cloudflare':
                # Locate cloudflared binary
                cf_bin = "cloudflared"
                for candidate in [
                    os.path.join(os.path.dirname(os.path.abspath(__file__)), "cloudflared.exe"),
                    os.path.join(os.path.dirname(os.path.abspath(__file__)), "bin", "cloudflared.exe"),
                    os.path.join(os.getcwd(), "cloudflared.exe"),
                    os.path.join(os.getcwd(), "bin", "cloudflared.exe"),
                ]:
                    if os.path.exists(candidate):
                        cf_bin = candidate
                        break

                cf_name = os.environ.get('CLOUDFLARE_TUNNEL_NAME') or os.environ.get('CLOUDFLARE_TUNNEL_ID')
                cf_custom_url = os.environ.get('CLOUDFLARE_TUNNEL_URL')

                if cf_name:
                    print(f"PLEASE WAIT... Starting Persistent Cloudflare Tunnel: {cf_name}...")
                    cf_cmd = [cf_bin, "tunnel", "run", cf_name]
                    public_url = cf_custom_url
                    
                    if not public_url:
                        print("⚠️  Warning: CLOUDFLARE_TUNNEL_URL not set. QR Code might be incorrect.")
                        public_url = "https://your-cloudflare-hostname.com"
                    
                    try:
                        cf_process = subprocess.Popen(cf_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                        time.sleep(2)
                    except FileNotFoundError:
                        print("❌ Error: 'cloudflared' binary not found.")
                        sys.exit(1)
                else:
                    print("PLEASE WAIT... Establishing Ephemeral Cloudflare Tunnel...", flush=True)
                    print("⏳ Connecting to Cloudflare edge network (typically takes 5-15s)...", flush=True)
                    cf_cmd = [cf_bin, "tunnel", "--url", addr, "--protocol", "http2"]
                    
                    if protocol == "https":
                        cf_cmd.append("--no-tls-verify")
                    
                    try:
                        cf_process = subprocess.Popen(
                            cf_cmd, 
                            stdout=subprocess.PIPE, 
                            stderr=subprocess.STDOUT, 
                            text=True, 
                            bufsize=1, 
                            universal_newlines=True
                        )
                        
                        start_time = time.time()
                        timeout = 60 # seconds
                        
                        while time.time() - start_time < timeout:
                            line = cf_process.stdout.readline()
                            if not line:
                                break
                            
                            line_str = line.strip()
                            if "Requesting new quick tunnel" in line_str:
                                print("   → Requesting tunnel assignment from Cloudflare...", flush=True)
                            elif "Registered tunnel connection" in line_str:
                                print("   → Edge connection established...", flush=True)

                            if ".trycloudflare.com" in line:
                                import re
                                match = re.search(r'https://[a-zA-Z0-9-]+\.trycloudflare\.com', line)
                                if match:
                                    public_url = match.group(0)
                                    break
                        
                        if not public_url:
                            print("❌ Failed to find Cloudflare Tunnel URL. Check internet connectivity.", flush=True)
                            cf_process.terminate()
                            sys.exit(1)
                            
                    except FileNotFoundError:
                        print("❌ Error: 'cloudflared' binary not found. Please install it.")
                        sys.exit(1)
                    except Exception as e:
                        print(f"❌ Failed to start Cloudflare Tunnel: {e}")
                        sys.exit(1)
            else:
                # Default to Ngrok
                # Check Ngrok Token
                token = os.environ.get('NGROK_AUTHTOKEN')
                if token:
                    ngrok.set_auth_token(token)
                else:
                    print("⚠️  Warning: NGROK_AUTHTOKEN not found in .env. Tunnel might expire.")

                print("PLEASE WAIT... Establishing Ngrok Tunnel...")
                tunnel = ngrok.connect(addr, host_header="rewrite")
                public_url = tunnel.public_url
            
            # Magic URL with password
            final_url = f"{public_url}?key={passcode}"
            
            print("\n" + "="*50)
            print(f"   🌍 GLOBAL WEB ACCESS ({provider.upper()})")
            print("="*50)
            print(f"🔗 Base URL: {public_url}")
            print(f"🔑 Passcode: {passcode}")
            
            print("\n📱 Scan this Magic QR Code (Auto-Logins):")
            print_qr(final_url)

            print("-" * 50)
            print("📝 Steps to Connect:")
            print("1. Switch your phone to Mobile Data or Turn off Wi-Fi.")
            print("2. Open your phone's Camera app or a QR scanner.")
            print("3. Scan the code above to auto-login.")
            print(f"4. Or visit {public_url}")
            print(f"5. Enter passcode: {passcode}")
            print("6. You should be connected automatically!")

        print("="*50)
        print("✅ Server is running in background. Logs -> server_log.txt")
        print("⌨️  Press Ctrl+C to stop.")
        
        # Keep alive loop
        last_log_pos = 0
        cdp_warning_shown = False
        
        while True:
            time.sleep(1)
            
            # Check process status
            if node_process.poll() is not None:
                if node_process.returncode == 0:
                    break
                print(f"\n⚠️ Server process stopped (code {node_process.returncode}). Restarting in 2s...")
                time.sleep(2)
                try:
                    log_file = open("server_log.txt", "a")
                    node_process = subprocess.Popen(node_cmd, stdout=log_file, stderr=subprocess.STDOUT)
                except Exception as restart_err:
                    print(f"\n❌ Server process died: {restart_err}")
                    sys.exit(1)
                
            # Monitor logs for errors
            try:
                if os.path.exists("server_log.txt"):
                    with open("server_log.txt", "r", encoding='utf-8', errors='ignore') as f:
                        f.seek(last_log_pos)
                        new_lines = f.read().splitlines()
                        last_log_pos = f.tell()
                        
                        for line in new_lines:
                            if "CDP not found" in line and not cdp_warning_shown:
                                print("\n" + "!"*50)
                                print("❌ ERROR: Antigravity Editor Not Detected!")
                                print("!"*50)
                                print("   The server cannot see your editor.")
                                print("   1. Close Antigravity.")
                                print("   2. Re-open it with the debug flag:")
                                print("      antigravity . --remote-debugging-port=9000")
                                print("   3. Or use the 'Open with Antigravity (Debug)' context menu.")
                                print("!"*50 + "\n")
                                cdp_warning_shown = True
            except Exception:
                pass

    except KeyboardInterrupt:
        print("\n\n👋 Shutting down...")
    except Exception as e:
        print(f"\n❌ Error: {e}")
        sys.exit(1)
    finally:
        # Cleanup
        try:
            if 'node_process' in locals() and node_process:
                node_process.terminate()
                try:
                    node_process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    node_process.kill()
            
            if args.mode == 'web':
                if provider == 'pinggy' and 'pinggy_tunnel' in locals():
                    try:
                        pinggy_tunnel.stop()
                    except Exception:
                        pass
                elif provider == 'cloudflare' and 'cf_process' in locals():
                    cf_process.terminate()
                elif 'ngrok' in locals():
                    ngrok.kill()
        except Exception:
            pass
        
        if 'log_file' in locals() and log_file:
            log_file.close()

if __name__ == "__main__":
    main()
