# 4-digit PINs: group rides, rider + pillion

| File | What it does |
|---|---|
| `pinpad.js` | The PIN pad. `PinPad.ask()`: four boxes (type, paste or the phone's one-time-code fill). The digits fly into a turning ring while the code is checked, then go green, gather into one tile with a tick and a burst; a wrong code shakes back into the row with the reason. `PinPad.show()`: a code to share, in glass tiles, with a countdown. `PinCore` is pure and tested. |
| `group-pin.js` | The group PIN, and the Group menu on the 🏁 button: start a ride, join with a PIN, rider & pillion. |
| `pillion.js` | Rider + pillion pairing and "Who's riding?". |
| `pinpad.css` | The styles. |

## Group rides
- The **server** gives every group ride a 4-digit PIN when it starts (`server.js`, `trip.start`). Only the riders in the ride get it (`tripData.pin`), so they can share it. Everyone else gets `locked: true` and no PIN.
- **Joining needs the PIN**, either from the ride offered on the map ("🔒 Join with PIN") or with the PIN alone (Group → Join with a PIN). The server checks it; the phone never sees another ride's PIN.
- **Wrong PINs:** 5 per phone in 10 minutes, and 20 per network address (a new device id per try doesn't get around it). After 20 wrong tries against one ride, its PIN changes and the host is told. The host can make a new PIN at any time (↻ in the trip panel); the old one stops working.

## Rider + pillion
- One phone shows a **code** (Group → Rider & pillion → Show my code). It works for 10 minutes, once. The other phone types it (I have a code). The same brakes apply: 5 wrong tries per phone, 20 per address, in 10 minutes.
- Then **both phones are asked "Who's riding?"**. Either can answer, and either can swap later (or unpair) from the same sheet.
- Once that's decided:
  - **on the map**, everyone sees one bike: the rider's marker carries "+1", and the pillion's marker is tucked under it;
  - **on the rider's phone**, the trip's fuel estimate counts the pillion;
  - **in a group ride**, the pillion is listed with the rider.
- A phone pairs with one partner at a time. The pairing lives on the server while it runs: a reconnecting phone (same device) gets it back, but a server restart ends it.
