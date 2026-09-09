## Should trigger
1. "You're in the exact-video-annotator repo. What region is our Firestore database in, and could we move it to us-central1 later if usage shifts to the US? Also, what's the command to deploy updated Firestore security rules?": 2/2 Haiku (Sonnet not run)
2. "In the Video Examiner app, Google sign-in works fine on localhost but on our new staging URL the popup opens and then nothing happens, no clear error. What's the likely cause and fix?": 0/2 Haiku (Sonnet not run) — Haiku answers this auth-debugging prompt from general knowledge (often wrongly, blaming Google Cloud OAuth redirect URIs) without loading the skill; the description names this symptom but Haiku still self-answers.
3. "For the exact-video-annotator app, can we store each user's exported annotation JSON in the Firebase backend so it syncs across their devices like the settings do?": 2/2 Haiku (Sonnet not run)

## Should not trigger
1. "In the exact-video-annotator repo, what format does the annotation autosave use and where is it stored?": 0/2 Haiku (Sonnet not run)
2. "Which video container formats can the Video Examiner app decode in Safari versus Chrome?": 0/2 Haiku (Sonnet not run)
3. "In the exact-video-annotator repo, how would I add a new checkbox preference to the settings modal and have it persist?": 0/2 Haiku (Sonnet not run)
