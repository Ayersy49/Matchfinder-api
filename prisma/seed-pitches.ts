import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

// Şehir mapping - dosya adı -> şehir
const FILE_CITY_MAP: Record<string, string> = {
  '01-29-41': 'İstanbul',
  '01-49-03': 'Ankara',
  '01-56-17': 'İzmir',
  '02-01-37': 'Bursa',
  '02-07-16': 'Antalya',
  '02-13-01': 'Samsun',
  '02-20-38': 'Eskişehir',
  '02-25-38': 'Adana',
  '02-28-12': 'Trabzon',
  '02-33-55': 'Sivas',
};

// UTF-8 encoding fix
function fixEncoding(str: string): string {
  if (!str) return str;
  return str
    .replace(/Ä±/g, 'ı')
    .replace(/Ä°/g, 'İ')
    .replace(/Ã¼/g, 'ü')
    .replace(/Ãœ/g, 'Ü')
    .replace(/ÅŸ/g, 'ş')
    .replace(/Åž/g, 'Ş')
    .replace(/Ã¶/g, 'ö')
    .replace(/Ã–/g, 'Ö')
    .replace(/Ã§/g, 'ç')
    .replace(/Ã‡/g, 'Ç')
    .replace(/ÄŸ/g, 'ğ')
    .replace(/Äž/g, 'Ğ')
    .replace(/â€"/g, '–')
    .replace(/TÃ¼rkiye/g, 'Türkiye');
}

// Adres'ten ilçe çıkar
function extractDistrict(address: string | null): string | null {
  if (!address) return null;
  // Örnek: "...61030 Ortahisar/Trabzon, Türkiye" -> "Ortahisar"
  const match = address.match(/(\d{5})\s+([^\/,]+)/);
  if (match) return match[2].trim();
  return null;
}

// Google Place ID çıkar
function extractGooglePlaceId(url: string | null): string | null {
  if (!url) return null;
  const match = url.match(/query_place_id=([^&]+)/);
  return match ? match[1] : null;
}

async function seedGooglePitches(uploadsDir: string) {
  console.log('🔍 Google Places verilerini işleniyor...');
  
  const files = fs.readdirSync(uploadsDir).filter(f => f.startsWith('dataset_crawler-google-places_'));
  console.log(`📁 ${files.length} Google dosyası bulundu`);
  
  let totalGoogle = 0;
  
  for (const file of files) {
    // Şehri dosya adından belirle
    const timeStamp = file.match(/(\d{2}-\d{2}-\d{2})/)?.[1];
    const city = timeStamp ? FILE_CITY_MAP[timeStamp] : null;
    
    if (!city) {
      console.log(`⚠️ ${file} için şehir bulunamadı, atlanıyor...`);
      continue;
    }
    
    const filePath = path.join(uploadsDir, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content);
    
    console.log(`📍 ${city}: ${data.length} saha`);
    
    for (const item of data) {
      const name = fixEncoding(item.title);
      const address = fixEncoding(item.address);
      const district = extractDistrict(address);
      const googlePlaceId = extractGooglePlaceId(item.url);
      
      // Duplicate check
      if (googlePlaceId) {
        const existing = await prisma.pitch.findUnique({
          where: { googlePlaceId }
        });
        if (existing) continue;
      }
      
      await prisma.pitch.create({
        data: {
          name: name || 'Halı Saha',
          city,
          district,
          address: fixEncoding(item.street) || address,
          lat: item.location?.lat,
          lng: item.location?.lng,
          phone: item.phone || null,
          googlePlaceId,
          sourceType: 'GOOGLE_VERIFIED',
          verificationLevel: 3,
          status: 'ACTIVE',
        }
      });
      totalGoogle++;
    }
  }
  
  console.log(`✅ ${totalGoogle} Google Places halı saha eklendi`);
  return totalGoogle;
}

async function seedOsmPitches(uploadsDir: string) {
  console.log('🗺️ Overpass/OSM verileri işleniyor...');
  
  const osmFile = path.join(uploadsDir, 'Tr_Halısaha.json');
  if (!fs.existsSync(osmFile)) {
    console.log('⚠️ Tr_Halısaha.json bulunamadı');
    return 0;
  }
  
  const content = fs.readFileSync(osmFile, 'utf-8');
  const data = JSON.parse(content);
  
  console.log(`📊 Toplam ${data.toplam_saha_sayisi} OSM sahası`);
  
  let totalOsm = 0;
  const pitches = data.veriler || [];
  
  for (const item of pitches) {
    const osmId = `${item.type}_${item.id}`;
    
    // Duplicate check
    const existing = await prisma.pitch.findUnique({
      where: { osmId }
    });
    if (existing) continue;
    
    // Koordinatları al (node vs way farklı)
    let lat: number, lng: number;
    if (item.type === 'node') {
      lat = item.lat;
      lng = item.lon;
    } else if (item.center) {
      lat = item.center.lat;
      lng = item.center.lon;
    } else {
      continue; // Koordinat yoksa atla
    }
    
    const tags = item.tags || {};
    const name = fixEncoding(tags.name) || 'Halı Saha';
    const city = fixEncoding(tags.sehir_adi) || 'Bilinmiyor';
    
    await prisma.pitch.create({
      data: {
        name,
        city,
        district: null,
        address: null,
        lat,
        lng,
        osmId,
        sourceType: 'OSM_CANDIDATE',
        verificationLevel: 0,
        status: 'UNKNOWN',
      }
    });
    totalOsm++;
    
    // Progress her 500'de
    if (totalOsm % 500 === 0) {
      console.log(`  ... ${totalOsm} OSM sahası eklendi`);
    }
  }
  
  console.log(`✅ ${totalOsm} OSM halı saha eklendi`);
  return totalOsm;
}

async function main() {
  console.log('🚀 Halı Saha Seed başlıyor...\n');
  
  // Mevcut pitch'leri temizle (opsiyonel)
  const existingCount = await prisma.pitch.count();
  if (existingCount > 0) {
    console.log(`⚠️ Mevcut ${existingCount} pitch var. Temizleniyor...`);
    await prisma.pitch.deleteMany();
  }
  
  const uploadsDir = '/mnt/user-data/uploads';
  
  const googleCount = await seedGooglePitches(uploadsDir);
  const osmCount = await seedOsmPitches(uploadsDir);
  
  console.log('\n📊 ÖZET:');
  console.log(`  Google Verified: ${googleCount}`);
  console.log(`  OSM Candidate: ${osmCount}`);
  console.log(`  TOPLAM: ${googleCount + osmCount}`);
  
  // İstatistikler
  const cityStats = await prisma.pitch.groupBy({
    by: ['city'],
    _count: { id: true },
    orderBy: { _count: { id: 'desc' } },
    take: 15,
  });
  
  console.log('\n🏙️ ŞEHİR DAĞILIMI (Top 15):');
  for (const stat of cityStats) {
    console.log(`  ${stat.city}: ${stat._count.id}`);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
