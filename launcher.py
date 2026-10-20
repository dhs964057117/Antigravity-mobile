import sys
import subprocess
import time
import random
import string
import os
import socket
import argparse
import logging
import threading
import urllib.request
import ssl
import re
import atexit
import queue

if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

# Automatically re-execute within project virtual environment if available
_venv_py = os.path.join(os.path.dirname(os.path.abspath(__file__)), "venv", "Scripts", "python.exe")
if sys.platform != "win32":
    _venv_py = os.path.join(os.path.dirname(os.path.abspath(__file__)), "venv", "bin", "python")
if os.path.exists(_venv_py) and os.path.abspath(sys.executable).lower() != os.path.abspath(_venv_py).lower():
    try:
        os.execv(_venv_py, [_venv_py] + sys.argv)
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
# System Power & Watchdog Helpers
# -----------------------------------------------------------------------------
def prevent_system_sleep():
    """Keeps the system and network awake while the remote server is running."""
    if sys.platform == "win32":
        try:
            import ctypes
            ES_CONTINUOUS = 0x80000000
            ES_SYSTEM_REQUIRED = 0x00000001
            ES_AWAYMODE_REQUIRED = 0x00000040
            res = ctypes.windll.kernel32.SetThreadExecutionState(
                ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED
            )
            if res:
                print("🛡️  Windows 防休眠保活已启动（锁屏或无操作时系统将保持运行，防止网络断开）。", flush=True)
        except Exception as e:
            print(f"⚠️  Windows 防休眠设置失败: {e}", flush=True)

def restore_system_sleep():
    """Restores default system sleep settings upon shutdown."""
    if sys.platform == "win32":
        try:
            import ctypes
            ctypes.windll.kernel32.SetThreadExecutionState(0x80000000)
        except Exception:
            pass

def find_cloudflared_bin():
    """Locates the cloudflared executable."""
    candidates = [
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "cloudflared.exe"),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "bin", "cloudflared.exe"),
        os.path.join(os.getcwd(), "cloudflared.exe"),
        os.path.join(os.getcwd(), "bin", "cloudflared.exe"),
    ]
    for candidate in candidates:
        if os.path.exists(candidate):
            return candidate
    return "cloudflared"

def wait_for_tunnel_url(process, timeout=60):
    """Read the URL with a real deadline, then keep draining the log pipe.

    Stopping reads after the URL fills the child's stdout pipe over time and
    can freeze an otherwise live tunnel process.
    """
    lines = queue.Queue()
    collecting = threading.Event()
    collecting.set()

    def drain_output():
        try:
            for line in process.stdout:
                if collecting.is_set():
                    lines.put(line)
        finally:
            process.stdout.close()
            if collecting.is_set():
                lines.put(None)

    threading.Thread(target=drain_output, daemon=True, name="cloudflare-log-drain").start()
    deadline = time.monotonic() + timeout
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError("Timed out waiting for a TryCloudflare URL")
            try:
                line = lines.get(timeout=remaining)
            except queue.Empty:
                raise RuntimeError("Timed out waiting for a TryCloudflare URL") from None
            if line is None:
                raise RuntimeError("cloudflared closed its output before providing a URL")
            match = re.search(r'https://[a-zA-Z0-9-]+\.trycloudflare\.com', line)
            if match:
                return match.group(0)
    finally:
        collecting.clear()


def start_cloudflare_tunnel(cf_bin, addr, protocol, cf_token=None, cf_name=None, custom_domain=None):
    """
    Starts Cloudflare Tunnel.
    Priority 1: Token-based Named Tunnel (cloudflared tunnel run --token <token>)
    Priority 2: Config/Named Tunnel (cloudflared tunnel run <name>)
    Priority 3: Ephemeral TryCloudflare tunnel (--url <addr>)
    Returns (cf_process, public_url).
    """
    if cf_token:
        print("PLEASE WAIT... Starting Persistent Cloudflare Tunnel via Token...", flush=True)
        cf_cmd = [cf_bin, "tunnel", "--protocol", "http2", "run", "--token", cf_token]
        if protocol == "https":
            cf_cmd.append("--no-tls-verify")

        public_url = custom_domain
        if not public_url:
            print("⚠️  Warning: CLOUDFLARE_TUNNEL_TOKEN is set, but CUSTOM_DOMAIN is not specified in .env.")
            print("    Please set CUSTOM_DOMAIN=https://your-domain.com for accurate QR code generation.")
            public_url = "https://your-cloudflare-hostname.com"
        elif not public_url.startswith("http://") and not public_url.startswith("https://"):
            public_url = f"https://{public_url}"

        try:
            cf_process = subprocess.Popen(cf_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            time.sleep(2)
            if cf_process.poll() is not None:
                raise RuntimeError(f"cloudflared exited immediately with code {cf_process.returncode}")
            return cf_process, public_url
        except FileNotFoundError:
            print("❌ Error: 'cloudflared' binary not found.")
            sys.exit(1)

    elif cf_name:
        print(f"PLEASE WAIT... Starting Persistent Cloudflare Tunnel: {cf_name}...", flush=True)
        cf_cmd = [cf_bin, "tunnel", "--protocol", "http2", "run", cf_name]
        public_url = custom_domain or os.environ.get('CLOUDFLARE_TUNNEL_URL')
        if not public_url:
            print("⚠️  Warning: CUSTOM_DOMAIN/CLOUDFLARE_TUNNEL_URL not set. QR Code might be placeholder.")
            public_url = "https://your-cloudflare-hostname.com"
        elif not public_url.startswith("http://") and not public_url.startswith("https://"):
            public_url = f"https://{public_url}"

        try:
            cf_process = subprocess.Popen(cf_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            time.sleep(2)
            if cf_process.poll() is not None:
                raise RuntimeError(f"cloudflared exited immediately with code {cf_process.returncode}")
            return cf_process, public_url
        except FileNotFoundError:
            print("❌ Error: 'cloudflared' binary not found.")
            sys.exit(1)

    else:
        # Ephemeral TryCloudflare Quick Tunnel
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
                encoding='utf-8',
                errors='replace',
                bufsize=1,
                universal_newlines=True
            )

            try:
                public_url = wait_for_tunnel_url(cf_process)
            except Exception:
                cf_process.terminate()
                try:
                    cf_process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    cf_process.kill()
                    cf_process.wait(timeout=3)
                raise

            return cf_process, public_url
        except FileNotFoundError:
            print("❌ Error: 'cloudflared' binary not found. Please install it.")
            sys.exit(1)

def start_tunnel_heartbeat(port, get_public_url, protocol="http", interval=30):
    """
    Background worker that sends periodic /health pings locally and via public tunnel.
    Keeps stateful firewalls, mobile carrier NAT tables, and Cloudflare edge proxies warm and active.
    """
    # Create SSL context that allows self-signed local certs
    ssl_ctx = ssl.create_default_context()
    ssl_ctx.check_hostname = False
    ssl_ctx.verify_mode = ssl.CERT_NONE

    def _worker():
        consecutive_fails = 0
        while True:
            time.sleep(interval)
            # 1. Local Node check
            try:
                local_url = f"{protocol}://127.0.0.1:{port}/health"
                req = urllib.request.Request(local_url, headers={'User-Agent': 'AGY-Heartbeat/1.0'})
                ctx = ssl_ctx if protocol == "https" else None
                with urllib.request.urlopen(req, timeout=5, context=ctx) as resp:
                    pass
            except Exception:
                pass

            # 2. Public tunnel check
            pub = get_public_url()
            if pub and not pub.startswith("http://localhost") and not pub.startswith("http://127.0.0.1") and "your-cloudflare-hostname" not in pub:
                try:
                    req = urllib.request.Request(f"{pub.rstrip('/')}/health", headers={'User-Agent': 'AGY-Heartbeat/1.0'})
                    with urllib.request.urlopen(req, timeout=8, context=ssl_ctx) as resp:
                        if resp.status == 200:
                            consecutive_fails = 0
                except Exception:
                    consecutive_fails += 1
                    if consecutive_fails == 6:
                        print("\n⚠️ [Heartbeat] Warning: 6 consecutive remote tunnel pings failed. Mobile connection may be degraded.", flush=True)

    t = threading.Thread(target=_worker, daemon=True)
    t.start()

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

    # Prevent system sleep / screen-off network suspension (Enabled by default)
    prevent_sleep = os.environ.get('PREVENT_SLEEP', 'true').strip().lower() in ('true', '1', 'yes')
    if prevent_sleep:
        prevent_system_sleep()
        atexit.register(restore_system_sleep)

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
                cf_bin = find_cloudflared_bin()
                cf_token = os.environ.get('CLOUDFLARE_TUNNEL_TOKEN')
                cf_name = os.environ.get('CLOUDFLARE_TUNNEL_NAME') or os.environ.get('CLOUDFLARE_TUNNEL_ID')
                custom_domain = os.environ.get('CUSTOM_DOMAIN') or os.environ.get('CLOUDFLARE_TUNNEL_URL')

                try:
                    cf_process, public_url = start_cloudflare_tunnel(
                        cf_bin=cf_bin,
                        addr=addr,
                        protocol=protocol,
                        cf_token=cf_token,
                        cf_name=cf_name,
                        custom_domain=custom_domain
                    )
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
                ngrok_domain = os.environ.get('NGROK_DOMAIN') or os.environ.get('CUSTOM_DOMAIN')
                if ngrok_domain:
                    tunnel = ngrok.connect(addr, host_header="rewrite", domain=ngrok_domain)
                else:
                    tunnel = ngrok.connect(addr, host_header="rewrite")
                public_url = tunnel.public_url

            # Shared active public URL container & background heartbeat keep-alive
            current_public_url = [public_url]
            start_tunnel_heartbeat(port, lambda: current_public_url[0], protocol=protocol, interval=30)
            
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
            
            # Check Node.js process status
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

            # Check Cloudflare tunnel process status (Auto-healing Watchdog)
            if args.mode == 'web' and provider == 'cloudflare' and 'cf_process' in locals() and cf_process is not None:
                if cf_process.poll() is not None:
                    exit_code = cf_process.returncode
                    print(f"\n⚠️ [Watchdog] Cloudflare 隧道进程异常退出 (退出码 {exit_code})，正在于 3 秒后主动拉起重启...", flush=True)
                    time.sleep(3)
                    try:
                        cf_process, new_url = start_cloudflare_tunnel(
                            cf_bin=cf_bin,
                            addr=addr,
                            protocol=protocol,
                            cf_token=cf_token,
                            cf_name=cf_name,
                            custom_domain=custom_domain
                        )
                        if new_url:
                            if new_url != public_url:
                                public_url = new_url
                                current_public_url[0] = public_url
                                final_url = f"{public_url}?key={passcode}"
                                print(f"🔄 [Watchdog] 隧道已自动拉起，新访问地址: {public_url}", flush=True)
                                print_qr(final_url)
                            else:
                                print(f"✅ [Watchdog] 隧道已成功重新拉起 -> {public_url}", flush=True)
                    except Exception as cf_err:
                        print(f"❌ [Watchdog] 隧道自动拉起失败: {cf_err}", flush=True)
                
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
        # Restore normal power management
        restore_system_sleep()

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
