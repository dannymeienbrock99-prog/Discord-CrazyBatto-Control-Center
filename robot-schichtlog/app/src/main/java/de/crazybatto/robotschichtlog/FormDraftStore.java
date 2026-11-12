package de.crazybatto.robotschichtlog;

import android.content.Context;
import android.os.Bundle;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;

/** Private, local UI drafts. No entry or production count is created until explicit saving. */
final class FormDraftStore {
    private FormDraftStore() {}

    static void save(Context context, String slot, String identity, Bundle values) {
        try {
            JSONObject json = new JSONObject();
            json.put("identity", identity);
            json.put("fields", new JSONArray(values.getStringArray("fields")));
            int[] choices = values.getIntArray("choices");
            JSONArray indices = new JSONArray();
            if (choices != null) for (int value : choices) indices.put(value);
            json.put("choices", indices);
            json.put("important", values.getBoolean("important"));
            ArrayList<String> media = values.getStringArrayList("pending");
            json.put("pending", media == null ? new JSONArray() : new JSONArray(media));
            context.getSharedPreferences("local-form-drafts-v1", Context.MODE_PRIVATE)
                    .edit().putString(slot, json.toString()).commit();
        } catch (Exception ignored) { /* Keep existing draft if malformed state is supplied. */ }
    }

    static Bundle load(Context context, String slot, String identity) {
        try {
            String raw = context.getSharedPreferences("local-form-drafts-v1", Context.MODE_PRIVATE)
                    .getString(slot, null);
            if (raw == null) return null;
            JSONObject json = new JSONObject(raw);
            if (!identity.equals(json.optString("identity"))) return null;
            Bundle values = new Bundle();
            JSONArray fields = json.getJSONArray("fields");
            String[] strings = new String[fields.length()];
            for (int i = 0; i < strings.length; i++) strings[i] = fields.optString(i, "");
            values.putStringArray("fields", strings);
            JSONArray choices = json.getJSONArray("choices");
            int[] indices = new int[choices.length()];
            for (int i = 0; i < indices.length; i++) indices[i] = choices.optInt(i, 0);
            values.putIntArray("choices", indices);
            values.putBoolean("important", json.optBoolean("important"));
            ArrayList<String> media = new ArrayList<>();
            JSONArray pending = json.optJSONArray("pending");
            if (pending != null) for (int i = 0; i < pending.length(); i++) media.add(pending.getString(i));
            values.putStringArrayList("pending", media);
            return values;
        } catch (Exception ignored) { return null; }
    }

    static void clear(Context context, String slot) {
        context.getSharedPreferences("local-form-drafts-v1", Context.MODE_PRIVATE).edit().remove(slot).commit();
    }
}
