export interface Faq {
  q: string;
  a: string;
}

export const FAQ: Faq[] = [
  {
    q: 'Is THRUSTLINE free?',
    a: 'Yes. The whole game is free, with no ads and no in-app purchases. Everyone plays with the same weapons.',
  },
  {
    q: 'Do I need an account?',
    a: 'No. Pick a callsign or take a random one and press Quick Play. Your level and season points are saved on your device.',
  },
  {
    q: 'How do I play with friends?',
    a: 'Press Create room, then Share in the lobby and send the link to your group. Anyone who opens it lands straight in your room. Rooms hold up to 8 players, as a free-for-all or as red and blue teams.',
  },
  {
    q: 'Can I play on my own?',
    a: 'Yes. Quick Play fills empty seats with CPU players, and in your own room you can add CPU players at easy, normal or hard skill.',
  },
  {
    q: 'Which devices does it run on?',
    a: 'Any phone, tablet or laptop with a modern browser. Phones play in landscape with twin-stick touch controls, and gamepads, keyboard and mouse work too. The Android app needs Android 7.0 or newer.',
  },
  {
    q: 'Will it run on a low-end phone?',
    a: 'It is built for it. Graphics adjust to your device automatically, trading effects for frame rate, and the whole game downloads in about 300 KB.',
  },
  {
    q: 'Does it need an internet connection?',
    a: 'Yes. THRUSTLINE is an online multiplayer game, so every match runs on the game server. Wi-Fi or mobile data both work.',
  },
  {
    q: 'Is there an Android app?',
    a: 'Yes, it is on its way to Google Play. It is the same game in a full-screen app under 1 MB, and it shares your progress with Chrome on the same phone.',
  },
  {
    q: 'What data does the game collect?',
    a: 'Only what the game needs: a random player ID, your callsign and your match stats. There are no accounts, ads or trackers. The privacy policy and data safety pages list everything.',
  },
  {
    q: 'Is the game open source?',
    a: 'Yes. The game, the server rules and this website are all on GitHub, and contributions are welcome.',
  },
];
