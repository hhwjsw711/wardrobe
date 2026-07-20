import GitHub from "@auth/core/providers/github";
import Google from "@auth/core/providers/google";
import Apple from "@auth/core/providers/apple";
import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Password,
    GitHub,
    Google,
    Apple({
      clientSecret: process.env.AUTH_APPLE_SECRET as string,
      client: {
        token_endpoint_auth_method: "client_secret_post",
      },
      profile: undefined,
    }),
  ],
});
