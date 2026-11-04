# Online İşitme Testi (trakyaisitme.com için, henüz yayında değil)

Kulaklıkla yapılan, adım adım ilerleyen online işitme testi sayfası. Sitenin renkleri,
yazı tipleri, logosu ve iletişim bilgileriyle hazırlandı. Hiçbir harici kütüphane kullanmaz.

## Akış
1. **Giriş**: süre, gerekenler (kulaklık, sessiz oda), uzman kartı, "tıbbi tanı değildir" notu.
2. **Anket (5 soru)**: kimin için, yaş, şikâyetler (çoklu seçim), ne zamandır, cihaz kullanımı.
   "Aniden başladı" seçilirse acil KBB uyarısı gösterilir.
3. **İletişim**: ad soyad, telefon (Türkiye formatı kontrolü) ve KVKK onayı (aydınlatma metniyle).
4. **Hazırlık**: kulaklık sağ/sol kontrolü (ters takılmışsa otomatik düzeltir, hoparlör/mono uyarır)
   ve referans sesle ses seviyesi ayarı.
5. **Test**: her kulak için 1000, 2000, 4000, 8000 ve 500 Hz. Darbeli saf ses, rastgele bekleme,
   basitleştirilmiş Hughson-Westlake (10 dB in / 5 dB çık). Ara sıra sessiz kontrol denemeleri yapılır.
   Duraklatma var; sekme değişince test kendiliğinden duraklar.
6. **Sonuç**: kulak başına ortalama ve derece, odyogram (sağ kırmızı O, sol mavi X), tablo,
   dikkat çeken noktalar (kulaklar arası fark, tiz seslerde düşüş, güvenilirlik), WhatsApp'a
   hazır mesajla gönderme ve arama düğmeleri.

Tasarımı görmek için: `index.html#ornek-sonuc` adresi testi yapmadan örnek bir sonuç ekranı açar.

## Dosyalar
| Dosya | Görevi |
|---|---|
| `index.html` | Sayfa (kendi başına çalışır) |
| `isitme-testi.css` | Stiller (sitenin `:root` değişkenleriyle aynı) |
| `isitme-testi.js` | Ses motoru, test ve form mantığı. Ayarlar dosyanın başındaki `CONFIG` bölümünde |
| `img/` | Siteden alınan logo ve Berkant Bey'in fotoğrafı |
| `google-sheets-baglantisi.gs` | İsteğe bağlı: başvuruları Google E-Tablosuna yazar |

## Başvurular nereye gider?
- **Varsayılan:** Sonuç ekranındaki "Sonucumu WhatsApp'tan gönder" düğmesi, anket cevapları,
  telefon ve test sonucunu içeren hazır bir mesajı 0544 182 18 81'e açar. Ziyaretçi göndermezse bilgi gelmez.
- **Önerilen ek:** `google-sheets-baglantisi.gs` kurulup adresi `CONFIG.LEAD_ENDPOINT` alanına
  yazılırsa, ziyaretçi iletişim formunu doldurduğu anda ve test bittiğinde tabloya satır düşer.

## Siteye eklerken
- Klasörü sitenin köküne `online-isitme-testi/` olarak koymak yeterli. Sayfa `/online-isitme-testi/` adresinde açılır.
- `index.html` içindeki `<meta name="robots" content="noindex">` satırı yayına alırken silinmeli.
- İstenirse üst bant ve alt bilgi, sitenin kendi header/footer'ı ile değiştirilebilir.
  Testin tamamı `<main id="it-app">` içinde çalışır.
- `/isitme-testi-edirne` sayfasından ve ana sayfadan bu sayfaya bağlantı verilebilir.
- KVKK aydınlatma metni genel bir taslaktır; yayından önce gözden geçirilmesi önerilir.

## Sınırlar
Ses seviyesi kalibre edilmiş bir odyometre ile değil, kullanıcının cihaz sesine göre ayarlanır.
Bu yüzden dB değerleri yaklaşıktır ve sayfa her yerde bunun tıbbi tanı olmadığını belirtir.
