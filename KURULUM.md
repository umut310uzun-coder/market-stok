# Market Stok & Satış — Kurulum Rehberi

Bu sistem 3 parçadan oluşur. Elektrik panosu gibi düşün:

| Parça | Ne işe yarar | Benzetme |
|---|---|---|
| **Supabase** (bulut veritabanı) | Ürünler, stok, satışlar burada durur. Bütün telefonlar buraya bağlanır. | Ana dağıtım panosu |
| **Uygulama** (`web` klasörü) | Telefonda/PC'de açılan ekran. Barkod okur, satış yapar. | Tali panolar / prizler |
| **n8n** | Stok azalınca ve her akşam Telegram'a mesaj atar. | Alarm rölesi |

Telefonlar aynı ağda olmak zorunda değil — mobil veriyle de çalışır.

---

## 1) Supabase kurulumu (2 dk)

Proje hazır: **market-stok** (Frankfurt). Sadece veritabanını yüklemek kaldı:

1. **supabase.com/dashboard/project/qozfusvegypczamjuzhz/sql/new** adresini aç
2. `supabase/KURULUM-TEK-ADIM.sql` dosyasının **tamamını** yapıştır → **Run** → "Success" yazmalı.

Kullanıcı açmak için Supabase paneline girmene gerek yok:
- Uygulamayı ilk açtığında **"Hoş geldiniz"** ekranı çıkar → kendi yönetici hesabını oluşturursun.
- Elemanları uygulamada ⚙️ **Ayarlar → Yeni kullanıcı ekle** ile açarsın (şifre değiştirme, pasif yapma da orada).
- Dışarıdan kimse kendi kendine hesap açamaz.

(n8n günlük rapor için gereken **service_role / secret key**: Project Settings → API Keys. Bunu ASLA uygulamaya yazma, sadece n8n'e.)

> Not: Ücretsiz Supabase projesi 7 gün hiç kullanılmazsa uykuya geçer. Market her gün kullanacağı için sorun olmaz; uzun tatilde panelden "Restore" denir.

---

## 2) Uygulamayı internete koyma (5 dk)

Kamera ile barkod okumak için adresin **https** olması şart. En kolay yol:

**Netlify Drop (ücretsiz, hesap açmadan bile denenir):**
1. Bilgisayarda **app.netlify.com/drop** aç
2. `web` klasörünü sürükleyip bırak
3. Sana `https://rastgele-isim.netlify.app` gibi bir adres verir. Hesap açıp adı `uzunmarket` gibi değiştirebilirsin.

Alternatif: Ev sunucuna (n8n'in olduğu makine) Nginx/Caddy ile koyabilirsin; https sertifikası olması yeter.

---

## 3) Telefonlara kurma

**Android (Chrome):** adresi aç → sağ üst ⋮ → **Uygulamayı yükle / Ana ekrana ekle**
**iPhone (Safari):** adresi aç → alttaki **Paylaş** ⬆️ → **Ana Ekrana Ekle**
**PC:** Chrome/Edge ile adresi aç. USB barkod okuyucu takılıysa barkod kutusuna tıklayıp okut, kendisi yazar.

Bağlantı bilgileri uygulamanın içine gömülü (`config.js`), telefonlarda hiçbir ayar girilmez.
Giriş: sadece kullanıcı adı (örn. `eleman1`) ve şifre.

---

## 4) Telegram bildirimleri (n8n)

### a) Stok uyarısı (anında)
1. n8n → **Import from file** → `n8n/1-stok-uyarisi.json`
2. "Gizli kelime doğru mu?" düğümünde `BURAYA_GIZLI_KELIME` yerine kendi kelimeni yaz (örn. `uzun2026market`)
3. "Telegram'a gönder" düğümünde Telegram bot bilgini seç, `BURAYA_TELEGRAM_CHAT_ID` yerine chat ID'ni yaz
4. Akışı **Active** yap. Webhook düğümündeki **Production URL**'i kopyala
5. Uygulamada ⚙️ **Ayarlar** → webhook adresini ve aynı gizli kelimeyi yaz → **Kaydet** → **Test mesajı gönder**
   → Telegram'a "✅ TEST" gelmeli.

Ne zaman mesaj gelir?
- 🟠 **AZALDI**: ürün, kartındaki "Uyarı (min)" sayısına indiğinde (bir kez)
- 🔴 **BİTTİ**: stok 0'a indiğinde

> n8n adresin internetten erişilebilir olmalı (Supabase bulutta, senin n8n'ine ulaşabilmeli). Ev sunucusundaysa Cloudflare Tunnel vb. ile dışarı açık olmalı.

### b) Günlük rapor (her akşam 21:00)
1. `n8n/2-gunluk-rapor.json` içe aktar
2. HTTP düğümünde `BURAYA_PROJE` ve iki yerdeki `BURAYA_SERVICE_ROLE_KEY` değerlerini doldur
   (yeni tip `sb_secret_...` anahtar kullanıyorsan `Authorization` satırını sil, sadece `apikey` kalsın)
3. Telegram chat ID → Active

---

## 5) Günlük kullanım

| Kim | Ekran | Ne yapar |
|---|---|---|
| Eleman | 🛒 Satış | Kamera ile okut → fiyat görünür → Sepete → Nakit/Kart. Stok otomatik düşer. Fiyat değiştiremez. |
| Sen | 📦 Ürünler | Ürün ekle/düzenle, **🌐 İnternetten bilgi bul**, **Barkod üret**, etiket yazdır, Excel'e aktar |
| Sen | 🧾 Fatura | Gelen e-faturanın XML/ZIP'ini seç → kalemler eşleşir → **Stoğa ekle** |
| Sen | 🔢 Sayım | Okut → "= Stok bu" (sayım) veya "+ Ekle" (gelen mal) |
| Sen | 📊 Rapor | Günlük ciro, en çok satanlar, azalanlar, satış iptali |

### İlk stok girişi (mevcut ürünlerin)
İki yol var:
- **Rafla sayım:** 🔢 Sayım ekranında ürünü okut → kayıtlı değilse "+ Ürün olarak ekle" → 🌐 ile ad/resim gelir → fiyatı yaz → kaydet → miktarı yaz.
- **Excel'den toplu:** Ürünler → **📥 Excel/CSV yükle**. Excel'de ilk satır başlık olsun:
  `Barkod | Ürün adı | Fiyat | Stok | Min stok | Birim | Kategori`
  Sonra **Dosya → Farklı Kaydet → CSV (noktalı virgülle ayrılmış)**.

### Barkodu olmayan ürünler (açık ürün, kuruyemiş, kendi paketlediklerin)
Ürün kartında **Barkod üret** → `200…` ile başlayan barkod verir. Ürünler → "Kendi barkodlu" filtresi → **🏷️ Etiket yazdır** (A4, 24'lü etiket kağıdı).

### E-fatura nasıl eşleşir?
1. Daha önce aynı tedarikçinin aynı ürün kodu eşleştirildiyse → **otomatik hatırlar** (koli çarpanı dahil)
2. Faturada barkod varsa → barkoddan bulur
3. Yoksa sen bir kere "Ürün seç" veya "+ Yeni ürün" dersin, bir dahakine kendisi bilir.
- Koli ile geliyorsa "1 koli = kaç adet" kutusuna 12/24 yaz.
- Maliyet **KDV ve iskonto dahil** hesaplanır; satış fiyatını aynı ekranda güncelleyip kâr yüzdesini görürsün.
- Aynı fatura iki kez işlenemez.
- PDF fatura okunmaz; sadece XML/ZIP. PDF ile gelen malı Sayım → "+ Ekle" ile gir.

---

## Dosyalar
```
market-stok/
├─ supabase/KURULUM-TEK-ADIM.sql → veritabanı (1 kere çalıştır)
├─ supabase/schema.sql      → aynı şema, eski tablo temizliği olmadan
├─ web/                     → uygulama (bu klasörü yayınla)
│   ├─ config.js            → isteğe bağlı: URL/key'i buraya sabitle
├─ n8n/1-stok-uyarisi.json  → anlık stok uyarısı
├─ n8n/2-gunluk-rapor.json  → akşam raporu
└─ test/                    → otomatik testler (kurulum için gerekmez)
```
