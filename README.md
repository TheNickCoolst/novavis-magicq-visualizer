# NovaVis L8 Pro — Echtzeit 3D Stage Lighting Visualizer für ChamSys MagicQ

Moderner, 100 % offline-fähiger 3D-Lichtvisualizer auf L8-Niveau mit **Live-Anpassung an ChamSys MagicQ** über **Art-Net 4 (UDP 6454)**, **sACN E1.31 (UDP 5568)**, **OSC (UDP 8000)** sowie automatischem **`.mvr` & `.csv` Live-Sync**.

## Schnellstart

Voraussetzung: [Node.js](https://nodejs.org) 18 oder neuer.

**Windows:** Doppelklick auf `start-windows.bat` (installiert beim ersten Start die Abhängigkeiten und öffnet den Browser).

**macOS:** Doppelklick auf `start-mac.command`.

**Manuell (alle Systeme):**

```bash
npm install
npm start
```

Öffne anschließend im Browser:
- **Lokal auf diesem Rechner:** `http://localhost:4321`
- **Tests ausführen (ArtPoll, ArtDmx, sACN & MVR-Import):** `npm run test:artnet`

### Hinweise für Windows

- Beim ersten Start fragt die **Windows-Firewall** nach Netzwerkzugriff für Node.js → für **private Netzwerke zulassen**, sonst kommen Art-Net/sACN-Pakete nicht an.
- MagicQ-Showordner werden automatisch gesucht: `Dokumente\MagicQ\show` (auch OneDrive), `C:\Users\Public\Documents\MagicQ\show`, `C:\Program Files\ChamSys Ltd\MagicQ PC\show`. Anderer Ordner: `set MAGICQ_SHOW_DIR=D:\Shows\show` vor dem Start.
- Laufen MagicQ und Visualizer auf **demselben Windows-PC** und kommen keine Daten an, in MagicQ für Art-Net **Broadcast** bzw. sACN (Multicast) als Ausgabe wählen.
- Bonjour/mDNS (`http://<rechner>.local:4321`) funktioniert nur, wenn Apple Bonjour installiert ist; per IP-Adresse geht es immer.

---

## Live-Verbindung & Auto-Anpassung mit ChamSys MagicQ

1. **Automatische Node-Erkennung (`ArtPollReply`)**
   - Öffne in MagicQ `Setup → View DMX I/O`.
   - NovaVis L8 Pro läuft mit `SO_REUSEADDR` parallel zu MagicQ auf demselben Rechner (`127.0.0.1`) oder über dein LAN und meldet sich automatisch als Visualizer-Node **`NovaVis L8 Pro`** (`Style = 0x03 StVisual`).
   - Aktiviere in MagicQ einfach **Universe 1 → Art-Net 0-0** und **Universe 2 → Art-Net 0-1** (bis zu **64 Universen** kostenlos ohne Hardware/Dongle).

2. **Drei Wege der Live-Anpassung**
   - **Zero-Export Auto-Adapt:** Sobald MagicQ DMX auf irgendeinem Universum (`1–64`) ausgibt, wechselt NovaVis automatisch in den Live-Modus und passt das 3D-Rig bei neuen Universen/Kanalbereichen automatisch an (*🔄 Live Auto-Adapt an MagicQ*).
   - **Automatischer Ordner-Sync (`.mvr` / `.csv`):** Speichere oder exportiere dein Patch/Rig in MagicQ (`Patch → View Vis → Export MVR` oder `Patch → View Heads → Export CSV`) nach `~/Documents/MagicQ/show` oder in den Projektordner `./magicq-sync/` — die 3D-Bühne lädt Positionen, Traversen und DMX-Adressen sofort im laufenden Betrieb nach.
   - **Drag & Drop + Live-3D-Inspector:** Ziehe jede beliebige `.mvr`-, `.xml`- oder `.csv`-Datei direkt in das 3D-Fenster oder klicke Lampen in 3D an, um Universum, Startadresse und X/Y/Z-Koordinaten live zu ändern.

---

## Tastenkürzel im 3D-Studio

| Taste | Funktion |
| :--- | :--- |
| `1` – `6` | Kamera-Presets (`FOH`, `Stage Lip`, `Aerial`, `Side Wing`, `Artist POV`, `Auto-Orbit`) |
| `Leertaste` | Interne Show Start / Pause |
| `B` | Sofort-Blackout |
| `H` | Highlight (ausgewählte Fixtures weiß zum Einleuchten) |
| `Tab` | Komplettes Studio-HUD ein-/ausblenden (Vollbild-Bühne) |
