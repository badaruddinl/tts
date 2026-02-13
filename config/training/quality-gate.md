# Quality Gate - Storytelling TTS

Gunakan checklist ini setiap selesai `train:self` atau `train:self:loop`.
Lulus jika 3 run berturut-turut memenuhi semua poin.

## Checklist

- [ ] Pause natural (tidak ada jeda aneh di tengah frasa).
- [ ] Tag tidak kebaca (`[SCENE: ...]`, `[PAUSE_*]` tidak ikut terucap).
- [ ] Transisi emosi halus (tidak patah saat pindah intent).
- [ ] Kecepatan bicara stabil antar kalimat.
- [ ] Intonasi manusiawi (tanya naik, penutup turun, tidak robotik berulang).
- [ ] Penekanan kata kunci tepat (cukup tegas, tidak berlebihan).
- [ ] Konsistensi karakter suara dari awal sampai akhir.
- [ ] Kebersihan audio baik (tanpa clipping/artefak potong kasar).
- [ ] Eval gate `pass` dan winner A/B stabil.
- [ ] Repeatability baik saat run ulang dengan config sama.

## Rule Stop

Stop loop jika 3 run terakhir semuanya lulus checklist.

## Rule Continue

Lanjut loop jika ada 1 saja poin gagal, lalu perbaiki di data feedback atau tuning rule.
