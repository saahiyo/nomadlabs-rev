# Nomad Labs — Complete Standalone Re-creation

A pixel-perfect, standalone implementation of the kinetic multi-column infinite grid, magnetic compass logo, and editorial presentation from [nomadlabs.es](https://nomadlabs.es/).

🌐 **Live Demo:** [https://nomadlabs-rev.vercel.app/](https://nomadlabs-rev.vercel.app/)

---

## 📁 Project Structure

```
nomadlabs/
├── index.html                   # Kinetic Home Grid & Integrated Fullscreen Project Player
├── about.html                   # Editorial Studio Story & Capabilities
├── list.html                    # Filterable Project Directory with Year Sort
├── standalone-controller.js     # Video Memory Pool & Player Interactive Logic
├── vimeo_data.json              # Direct progressive 1080p MP4 streaming data
├── vercel.json                  # Clean URL routing configuration
├── favicon.ico                  # Standard browser tab favicon
├── favicon-32x32.png            # 32x32 PNG favicon
├── favicon-192x192.png          # 192x192 PNG favicon
├── apple-touch-icon.png         # iOS touch icon
└── assets/
    ├── fonts/
    │   └── NeueHaasDisplayMediu.R51z8-e-.woff   # Official Neue Haas Display font
    ├── css/
    │   ├── fonts.css
    │   ├── global.css
    │   ├── header.css
    │   ├── home-grid.css
    │   ├── single-project.css
    │   ├── list-view.css
    │   └── about.css
    └── js/
        ├── home-grid.js         # Infinite multi-column conveyor physics
        ├── logo-spin.js         # Magnetic compass asterisk cursor tracking
        ├── frontend.js          # Menu toggle and page helpers
        └── about.js             # Stagger reveal for about sections
```

---

## 🚀 How to Run

### Option 1: Live Web Demo
Visit **[https://nomadlabs-rev.vercel.app/](https://nomadlabs-rev.vercel.app/)**

### Option 2: Local HTTP Server
From PowerShell or Terminal in this folder:
```powershell
python -m http.server 8089
```
Then visit: **http://localhost:8089**

### Option 3: Direct File
Simply open `index.html` in Chrome, Edge, Safari, or Firefox.
