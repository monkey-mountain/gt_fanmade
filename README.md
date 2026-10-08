# GT Fanmade

A fan-made, browser-based 3D racing game inspired by the "real driving" console racers.
Built with [Three.js](https://threejs.org/) and the Web Audio API. There's no build step and
there are no asset files: every model, texture and sound is generated in code.

> **Unofficial fan project.** This game is not affiliated with, endorsed by, or connected to
> Sony Interactive Entertainment or Polyphony Digital. All cars, sponsors, drivers and the
> circuit are fictional.

## Features

- **3D circuit**: a 2.6 km original track ("Monkey Mountain Raceway") with curbs, gravel traps,
  armco barriers, a grandstand crowd, pit building, start gantry with lights, billboards, a
  forest, mountains, a physically based sky and real-time shadows.
- **Driving physics**: an engine torque curve, a 6-speed automatic gearbox with rev limiter,
  traction limits, aero downforce, weight transfer (body roll and pitch), handbrake slides,
  and reduced grip on grass and sand.
- **3 original cars**: *Kestrel RS* (balanced), *Orion V8* (muscle) and *Mistral GT-P* (aero prototype),
  each with 9 paint colours.
- **Modes**: an *Arcade Race* (3 laps against 5 AI drivers who start ahead of you) and a *Time Trial*
  (solo, with your best lap saved per car).
- **Synthesised sound**: the engine note follows RPM and cylinder count, and there are tyre squeal,
  wind, gravel rumble, barrier scrape, collision thuds, gear-shift pops, countdown beeps and
  3D-positioned opponent engines.
- **HUD**: an analogue tachometer, speed, gear, position, lap, lap timers and a minimap.
- **4 camera views**: chase, far chase, hood and bumper.
- **Effects**: skid marks and tyre smoke or dirt spray.
- **Gamepad support**.

## Play locally

ES modules need to be served over HTTP, so opening `index.html` directly won't work. From this folder, run:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Three.js is loaded from the jsDelivr CDN, so you need an internet connection.

You can also host it on **GitHub Pages**: go to *Settings → Pages → Deploy from a branch → `main` / root*.

## Controls

| Action | Keyboard | Gamepad |
| --- | --- | --- |
| Accelerate | ↑ / W | RT |
| Brake / reverse | ↓ / S | LT |
| Steer | ← → / A D | Left stick |
| Handbrake | Space | B |
| Change camera | C | Y |
| Reset car to track | R | Back |
| Pause | P / Esc | Start |
| Mute | M | |

## Project layout

```
index.html      page shell, HUD and menu markup, import map
style.css       UI styling
src/main.js     renderer, scene, game states, camera, main loop
src/track.js    circuit spline, road/curb/barrier meshes, scenery
src/car.js      car specs and player vehicle physics
src/carModel.js procedural car meshes
src/ai.js       AI opponents (curvature-based speed planning + overtaking)
src/audio.js    Web Audio synthesis
src/hud.js      HUD, tachometer and minimap
src/input.js    keyboard and gamepad
src/fx.js       skid marks and smoke
```
