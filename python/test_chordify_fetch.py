import urllib.request, json, ssl
urls = [
  "https://chordify.net/api/v2/songs/youtube:QjuNCzO7ibY/chords?vocabulary=extended_inversions",
  "https://chordify.net/api/v2/songs/youtube:JZtIF0wpi5g/chords?vocabulary=extended_inversions",
]
for u in urls:
    print("TRY", u)
    try:
        req = urllib.request.Request(u, headers={"User-Agent":"Mozilla/5.0", "Accept":"application/json"})
        ctx = ssl.create_default_context()
        with urllib.request.urlopen(req, timeout=10, context=ctx) as r:
            body = r.read()
            print("OK", r.status, len(body))
            print(body[:1800].decode(errors="ignore"))
    except Exception as e:
        import traceback; traceback.print_exc()
        print("ERR", e)
