# ADR-000 — Adoptar el modelo del curso, calibrado a un hackathon, con SDD como núcleo

- **Estado:** Aceptada
- **Fecha:** 2026-07-24
- **Deciden:** Mateo (solo build)
- **Contexto de origen:** modelo de creación de proyecto de `Curso-IA/` (Hardcore AI 30X)

## Contexto

El repo de referencia `Curso-IA/Agente-IA-Desarrollo-ABAP/` propone un ciclo de
proyecto **spec-first y agent-ready** de 9 estaciones: capa de contexto
(`AGENTS.md` + `CLAUDE.md` + `.claude/`), capa de spec (PRD → ADR → C4 → AI-DLC
inception/construction), y capa de verificación (QA Persona+Juez + Terraform IaC).
Está diseñado para un producto corporativo con trazabilidad total.

Verdict es un hackathon **solo y time-boxed**. Aplicar el modelo entero sería
ceremonia: AI-DLC vendorizado, planning waves de OpenSymphony/Linear y Terraform
consumirían el fin de semana sin mover la aguja del jurado.

## Decisión

Adoptar un **subset calibrado** que conserva **la disciplina Spec-Driven Development
completa** y descarta la maquinaria pesada.

**Se conserva:**
- **SDD como ley** (`specs/`): el spec es el contrato; no hay código sin spec aprobado.
- **Capa de contexto**: `AGENTS.md`, `CLAUDE.md`, `.claude/{settings,skills,agents}`.
- **ADRs** para los trade-offs que el jurado va a interrogar.
- **Harness de evaluación** estilo Persona+Juez (`qa/`) que produce la métrica estrella.

**Se descarta (para este hackathon):**
- AI-DLC inception/construction vendorizado y `aidlc-rules/`.
- OpenSymphony / planning waves / Linear.
- Terraform IaC (el deploy se hace con Vercel).
- Memoria evolutiva formal (se usa el sistema de memoria existente de Claude Code).

## Consecuencias

- ✅ Máximo apalancamiento: el andamiaje que se construye acelera el build y alimenta el pitch.
- ✅ SDD intacto → cero *vibe coding*, drift controlado, oracle ejecutable.
- ⚠️ Sin AI-DLC formal, la trazabilidad requirement→código es más ligera; se compensa con `BR-N` en cada spec y ADRs.
- ⚠️ Si el proyecto sobrevive al hackathon y crece, habrá que **promover** este subset al modelo completo (re-introducir AI-DLC y IaC). Documentado como deuda deliberada.
