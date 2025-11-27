"use strict";
// prisma/seed-test-users.ts
// Test için 10 fake kullanıcı oluşturur
// Çalıştır: npx ts-node prisma/seed-test-users.ts
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
const TEST_USERS = [
    { username: 'ali_forvet', phone: '5551000001', level: 7 },
    { username: 'veli_kaleci', phone: '5551000002', level: 8 },
    { username: 'ahmet_stoper', phone: '5551000003', level: 6 },
    { username: 'mehmet_orta', phone: '5551000004', level: 5 },
    { username: 'can_kanat', phone: '5551000005', level: 9 },
    { username: 'emre_defans', phone: '5551000006', level: 7 },
    { username: 'burak_golcu', phone: '5551000007', level: 8 },
    { username: 'serkan_libero', phone: '5551000008', level: 6 },
    { username: 'ozan_playmaker', phone: '5551000009', level: 10 },
    { username: 'kerem_joker', phone: '5551000010', level: 5 },
];
async function main() {
    console.log('🚀 Test kullanıcıları oluşturuluyor...\n');
    const created = [];
    const skipped = [];
    for (const u of TEST_USERS) {
        // Zaten var mı kontrol et
        const existing = await prisma.user.findFirst({
            where: {
                OR: [
                    { username: u.username },
                    { phone: u.phone },
                ],
            },
        });
        if (existing) {
            skipped.push(u.username);
            continue;
        }
        const user = await prisma.user.create({
            data: {
                phone: u.phone,
                username: u.username,
                level: u.level,
                city: 'İstanbul',
                district: 'Kadıköy',
                elo: 1000 + (u.level * 50),
                positions: {
                    create: [
                        { position: 'ST', priority: 1 },
                        { position: 'CM', priority: 2 },
                    ],
                },
            },
        });
        created.push(`${u.username} (ID: ${user.id})`);
    }
    console.log('✅ Oluşturulan kullanıcılar:');
    created.forEach((c) => console.log(`   - ${c}`));
    if (skipped.length) {
        console.log('\n⏭️  Zaten var olanlar (atlandı):');
        skipped.forEach((s) => console.log(`   - ${s}`));
    }
    console.log('\n📋 Kullanım:');
    console.log('   Davet modal\'ında şu username\'leri kullanabilirsin:');
    console.log('   ali_forvet, veli_kaleci, ahmet_stoper, mehmet_orta, can_kanat');
    console.log('   emre_defans, burak_golcu, serkan_libero, ozan_playmaker, kerem_joker');
    console.log('\n   Veya telefon numaraları: 5551000001 - 5551000010\n');
}
main()
    .catch((e) => {
    console.error('❌ Hata:', e);
    process.exit(1);
})
    .finally(async () => {
    await prisma.$disconnect();
});
