-- ============================================================
-- Carry phone from signup metadata into the new profile row
-- ============================================================
-- The signup form (src/app/(auth)/login/page.tsx) now collects a
-- phone number and passes it in auth signUp options.data, landing in
-- auth.users.raw_user_meta_data->>'phone'. Extend handle_new_user()
-- (originally defined in migration 001) to copy it into profiles.phone,
-- exactly like full_name. Blank/absent → '' (onboarding still asks for
-- it; see isProfileComplete in src/lib/profile.ts). The trigger
-- on_auth_user_created already points at this function, so it is not
-- recreated here.
-- ============================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, phone, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'phone', ''),
    'user'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;
