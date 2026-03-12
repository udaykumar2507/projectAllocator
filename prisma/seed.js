import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { faker } from "@faker-js/faker";

import {
  PrismaClient,
  Role
} from "../src/generated/prisma/index.js";

// Build PG adapter (required for Prisma Accelerate driver)
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ---------------- CONFIG ----------------
const CONFIG = {
  allocators: 2,
  users: 10,
  projects: 6,
  minAllocationsPerUser: 1,
  maxAllocationsPerUser: 3,
  passwordPlain: "password123",     // UNHASHED
  fakerSeed: 7777
};

// Utility - generate project date span
function randomProjectDates() {
  const start = faker.date.soon({ days: faker.number.int({ min: 1, max: 20 }) });
  const end = faker.date.soon({
    days: faker.number.int({ min: 40, max: 180 }),
    refDate: start
  });
  return { startDate: start, endDate: end };
}

async function resetAll() {
  await prisma.allocation.deleteMany();
  await prisma.project.deleteMany();
  await prisma.user.deleteMany();
}

// ---------------- MAIN SEED LOGIC ----------------
async function main() {
  faker.seed(CONFIG.fakerSeed);

  console.log("🔄  Resetting database...");
  await resetAll();

  // -------------------------------- USERS -------------------------------
  console.log("👤  Creating Allocators...");
  const allocatorData = Array.from({ length: CONFIG.allocators }).map((_, i) => {
    const f = faker.person.firstName();
    const l = faker.person.lastName();
    return {
      name: `${f} ${l}`,
      email: `${f}.${l}.${i}@example.com`.toLowerCase(),
      password: CONFIG.passwordPlain,
      role: Role.ALLOCATOR
    };
  });

  await prisma.user.createMany({ data: allocatorData });

  console.log("👥  Creating Users...");
  const userData = Array.from({ length: CONFIG.users }).map((_, i) => {
    const f = faker.person.firstName();
    const l = faker.person.lastName();
    return {
      name: `${f} ${l}`,
      email: `${f}.${l}.${i}@example.com`.toLowerCase(),
      password: CONFIG.passwordPlain,
      role: Role.USER
    };
  });

  await prisma.user.createMany({ data: userData });

  const allocators = await prisma.user.findMany({ where: { role: Role.ALLOCATOR } });
  const users = await prisma.user.findMany({ where: { role: Role.USER } });

  // -------------------------------- PROJECTS ----------------------------
  console.log("📦  Creating Projects...");
  const usedCodes = new Set();
  const projectPayload = Array.from({ length: CONFIG.projects }).map(() => {
    // unique 3 letters + 3 numbers
    let code;
    do {
      code =
        faker.string.alpha({ length: 3, casing: "upper" }) +
        String(faker.number.int({ min: 1, max: 999 })).padStart(3, "0");
    } while (usedCodes.has(code));
    usedCodes.add(code);

    const { startDate, endDate } = randomProjectDates();
    const creator = faker.helpers.arrayElement(allocators);

    return {
      clientName: faker.company.name(),
      projectName: faker.commerce.productName(),
      projectCode: code,
      startDate,
      endDate,
      createdById: creator.id
    };
  });

  await prisma.project.createMany({ data: projectPayload });
  const projects = await prisma.project.findMany();

  // ------------------------------- ALLOCATIONS --------------------------
  console.log("📊  Creating Allocations...");
  const allocations = [];

  for (const user of users) {
    const count = faker.number.int({
      min: CONFIG.minAllocationsPerUser,
      max: Math.min(CONFIG.maxAllocationsPerUser, projects.length)
    });

    const selectedProjects = faker.helpers.arrayElements(projects, count);
    let remaining = 100;

    selectedProjects.forEach((proj, idx) => {
      if (remaining <= 0) return;

      const isLast = idx === selectedProjects.length - 1;
      const maxPct = Math.min(remaining, 60);

      let pct = isLast
        ? faker.number.int({ min: Math.min(10, remaining), max: remaining })
        : faker.number.int({ min: 10, max: maxPct });

      pct = Math.min(pct, remaining);
      remaining -= pct;

      allocations.push({
        userId: user.id,
        projectId: proj.id,
        percentage: pct
      });
    });
  }

  // Deduplicate (userId, projectId)
  const map = new Map();
  for (const a of allocations) {
    const key = `${a.userId}:${a.projectId}`;
    if (!map.has(key)) {
      map.set(key, a);
    } else {
      const prev = map.get(key);
      prev.percentage = Math.min(100, prev.percentage + a.percentage);
    }
  }

  await prisma.allocation.createMany({ data: [...map.values()] });

  console.log("🎉  SEED COMPLETE!");
  console.log("🔑  UNHASHED PASSWORD FOR ALL USERS:", CONFIG.passwordPlain);
}

// Run seed
main()
  .catch(err => {
    console.error("❌ Seed Failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });