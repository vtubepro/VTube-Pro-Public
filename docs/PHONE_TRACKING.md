# Use your phone for face tracking

A phone can track your face for the studio on your computer. An iPhone with Face ID tracks better than most webcams
(it sees depth), and the tracking then runs on the phone, which takes that work off your computer. Any phone can also
stand in as a plain webcam. You don't type addresses or open ports: VTube Pro finds the phone and tells you if Windows
is in the way.

This guide is in plain words. The technical details are in [Phone & external tracking](INTEGRATION.md).

---

## Before you start

- The phone and the computer are on the **same Wi-Fi** (or the computer is plugged into the same router).
- VTube Pro is running on the computer.
- Pick your app (below) and install it on the phone.

| Your phone | Best choice | Who does the tracking | Cost |
|---|---|---|---|
| iPhone or iPad with Face ID | **VTube Studio** (VTube Pro finds the iPhone by itself) | The phone | Free (its free version may stop sending after 5 minutes; its PRO upgrade removes that) |
| iPhone with Face ID | **iFacialMocap** / **FaceMotion3D** (very good for 3D avatars) | The phone | Paid app |
| iPhone 12 or newer | **Live Link Face** (by Epic) | The phone | Free |
| iPhone | **Waidayo** (sends **VMC**) | The phone | Free |
| Android | **MeowFace** (older free app from itch.io; no longer updated, so it may not work on newer Android phones: if it won't connect, use the phone as a webcam instead (see below). It speaks VTube Studio's phone protocol, so VTube Pro finds the phone by itself) | The phone | Free |
| Android | **AndroidMoCap** (sends **VMC**; install the APK from its GitHub releases page; a third-party app we haven't tested yet) | The phone | Free |
| Android or any phone | Use it **as a webcam**: **Iriun**, **DroidCam**, **Camo**, or Windows **Phone Link** | **Your computer** (the phone is only a camera) | Free versions exist |

iPhone apps track best. VTube Studio on **Android** can't send to other PC apps (only to VTube Studio on a PC), so it
isn't in this list.

### Does the phone take the tracking work off my computer?

Only when the phone runs the tracking itself: every row above except the last one. The phone then sends a few numbers
over Wi-Fi and your computer only moves the avatar.

**DroidCam, Iriun, Camo and Phone Link don't.** They turn the phone into a webcam, so your computer still runs the face
tracker on the picture (and also decodes the video). Use them when you want a better camera, not a lighter computer.

With an Android phone, the way to take the tracking off your computer is a VMC app such as **AndroidMoCap**. It uses
the phone's normal camera, so expect webcam-like tracking quality.

**Turn your computer's camera off** once the phone drives your avatar (Tracking → the camera card → **Turn off**). While
the computer's camera is on, VTube Pro keeps tracking it too, as a backup if the phone goes quiet and for your hands and
body. With it off, the phone does all the face work.

---

## Set it up (about 2 minutes)

1. In the studio, open **Tracking**. Find the **📱 Phone face tracking** card and press **Use my phone for face
   tracking**.
2. **Which phone app?** Pick yours. Not sure what your app sends? Open it on the phone and press **Not sure which app? Find my phone**: VTube Pro listens on every usual port at once, names the app it hears (and the phone's address) and picks it for you. It stops by itself after two minutes.
3. **Connect.** Follow the one or two steps shown for your app. For example, in VTube Studio: open its settings and
   turn on **3rd Party PC Clients**.
4. Press **Use this now**.
5. **What you'll see:** *Receiving your face* with a green light, and *✓ &lt;your app&gt; drives your avatar*. Move your
   head: your avatar follows. If the phone goes quiet, the webcam takes over by itself (when it is on). To take the
   tracking work off your computer, turn the computer's camera off: the phone keeps driving your avatar.
6. **Rest pose:** look straight ahead, hold still and press **Re-centre now (hold still 1 s)**.
7. Press **Finish**.

Nothing switches on by itself: the phone is only used after you press **Use this now**. To go back, press **Back to the
webcam** (or **Use webcam** on the card).

### If the app asks for the computer's address

Some apps (iFacialMocap if it can't find the computer, Live Link Face, VMC apps) need it typed in. The wizard shows this
computer's address in big letters, with **Copy** and a QR code. Type it into the phone app exactly as shown. (VPN and
virtual addresses are hidden: phones can't use them.)

---

## If your phone isn't found

The status line says what's wrong in one sentence. The two usual reasons are on Windows:

**Windows firewall.** The card shows a **Windows firewall** row. Press **Let phones connect**, then choose **Yes** when
Windows asks *"Do you want to allow this app to make changes?"*. This lets phones on your home Wi-Fi reach VTube Pro
(only its phone connections). You'll see *Done: phones on your home Wi-Fi can reach VTube Pro now.*

**Your network is set to Public.** Windows blocks phones on a network it thinks is public (a café, say). If yours is
your home network, press **Open network settings**, click your network and choose **Private network**. VTube Pro never
changes this for you.

**Still nothing?** Open **Doesn’t find your phone? Type its IP address** and type the address the phone app shows.

---

## "That's not my phone"

The first phone that sends is the one that's used, and the card shows its address (*Phone: …*). If someone else's phone
on your Wi-Fi got there first, press **That’s not my phone**. It's ignored, and the next phone that sends is used.
The first phone is kept even when it goes quiet (closed the app, new Wi-Fi address): no other device on the network can take over by itself. If a different phone starts sending, the studio asks "Another phone is sending — use it?" and you press Use it (or "That's not my phone"). While the Find my phone search is open, a new phone is taken straight away.

---

## Phone as a webcam (Android, or any phone)

This uses the phone as a camera only: your computer still does the face tracking. To take that work off your computer,
use a VMC app instead.

1. Install the app on the phone and its small PC part on the computer: **Iriun**, **DroidCam** or **Camo**. On Windows
   11 you can also use **Phone Link**: Settings → Bluetooth & devices → Mobile devices → turn on *Use as a connected
   camera*.
2. In the wizard, pick **Android: phone as a webcam**. Your phone appears as *Your phone (…)*. Press **Use this
   camera**.
3. Prop the phone at eye level. A USB cable is steadier than Wi-Fi.

VTube Pro prefers a phone webcam from Iriun, DroidCam, Camo, iVCam or Continuity Camera over a built-in laptop camera
by itself.

---

## Phone buttons (VTube Studio)

VTube Studio shows buttons 1–8 on the phone's screen. In the wizard's **Phone buttons** step, pick what each one does:
your model's expressions (the default: button 1 = expression 1), **Recalibrate my face**, a smile or surprise for a
moment, **Wave (emote)**, lights, **Hide my screen on / off**, **Slap!**, a key of your model, or **Nothing**. Tap a
number on the phone to try it.
