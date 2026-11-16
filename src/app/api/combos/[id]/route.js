import { NextResponse } from "next/server";
import { getComboById, updateCombo, deleteCombo, getComboByName } from "@/lib/localDb";
import { validateComboReferences } from "@/lib/comboPayload";
import { comboMembersToModels, normalizeComboKeyIds, normalizeComboMembers } from "@/shared/utils/comboMembers.js";
import { resetComboRotation } from "open-sse/services/combo.js";

// Validate combo name: only a-z, A-Z, 0-9, -, _
const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

// GET /api/combos/[id] - Get combo by ID
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const combo = await getComboById(id);
    
    if (!combo) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }
    
    return NextResponse.json(combo);
  } catch (error) {
    console.log("Error fetching combo:", error);
    return NextResponse.json({ error: "Failed to fetch combo" }, { status: 500 });
  }
}

// PUT /api/combos/[id] - Update combo
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    
    // Validate name format if provided
    if (body.name) {
      if (!VALID_NAME_REGEX.test(body.name)) {
        return NextResponse.json({ error: "Name can only contain letters, numbers, -, _ and ." }, { status: 400 });
      }
      
      // Check if name already exists (exclude current combo)
      const existing = await getComboByName(body.name);
      if (existing && existing.id !== id) {
        return NextResponse.json({ error: "Combo name already exists" }, { status: 400 });
      }
    }

    const prev = await getComboById(id);
    if (!prev) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    const patch = { ...body };
    if (body.members !== undefined) {
      const normalizedMembers = normalizeComboMembers(body.members, {
        models: body.models ?? prev.models ?? [],
      });
      patch.members = normalizedMembers;
      patch.models = comboMembersToModels(normalizedMembers);
    }
    const effectiveMembers = patch.members !== undefined ? patch.members : prev.members || [];
    const effectiveKeyIds = body.keyIds !== undefined
      ? normalizeComboKeyIds(body.keyIds)
      : prev.keyIds || [];
    if (body.keyIds !== undefined) patch.keyIds = effectiveKeyIds;

    // Validate references when members or keys actually change. A models-only
    // patch keeps existing members (and their already-validated accounts).
    if (body.members !== undefined || body.keyIds !== undefined) {
      const referenceError = await validateComboReferences({
        members: effectiveMembers,
        keyIds: effectiveKeyIds,
        allowMissingKeyIds: prev.keyIds || [],
        allowMissingConnectionIds: (prev.members || [])
          .map((member) => member.connectionId)
          .filter(Boolean),
      });
      if (referenceError) {
        return NextResponse.json({ error: referenceError }, { status: 400 });
      }
    }

    const combo = await updateCombo(id, patch);

    // Invalidate rotation state (models/strategy/name may have changed)
    if (prev?.name) resetComboRotation(prev.name);
    if (combo.name && combo.name !== prev?.name) resetComboRotation(combo.name);

    return NextResponse.json(combo);
  } catch (error) {
    console.log("Error updating combo:", error);
    return NextResponse.json({ error: "Failed to update combo" }, { status: 500 });
  }
}

// DELETE /api/combos/[id] - Delete combo
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const prev = await getComboById(id);
    const success = await deleteCombo(id);
    
    if (!success) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    if (prev?.name) resetComboRotation(prev.name);
    
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting combo:", error);
    return NextResponse.json({ error: "Failed to delete combo" }, { status: 500 });
  }
}
