import { pipe } from "fp-ts/function"
import * as O from "fp-ts/Option"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/lib/TaskEither"
import * as qjs from "quickjs-emscripten"
import cloneDeep from "lodash/clone"
import { Environment, parseTemplateStringE } from "@hoppscotch/data"
import { getEnv, setEnv } from "./utils"
import * as crypto from "crypto-browserify"
import {KJUR} from 'jsrsasign'

type Envs = {
  global: Environment["variables"]
  selected: Environment["variables"]
}

export const execPreRequestScript = (
  preRequestScript: string,
  envs: Envs,
  requestBody: string
): TE.TaskEither<string, Envs, string> =>
  pipe(
    TE.tryCatch(
      async () => await qjs.getQuickJS(),
      (reason) => `QuickJS initialization failed: ${reason}`
    ),
    TE.chain((QuickJS) => {
      let currentEnvs = cloneDeep(envs)

      const vm = QuickJS.createVm()

      const pwHandle = vm.newObject()

      const phHandle = vm.newObject()

      // Environment management APIs
      // TODO: Unified Implementation
      const envHandle = vm.newObject()

      const envGetHandle = vm.newFunction("get", (keyHandle) => {
        const key: unknown = vm.dump(keyHandle)

        if (typeof key !== "string") {
          return {
            error: vm.newString("Expected key to be a string"),
          }
        }

        const result = pipe(
          getEnv(key, currentEnvs),
          O.match(
            () => vm.undefined,
            ({ value }) => vm.newString(value)
          )
        )

        return {
          value: result,
        }
      })

      const envGetResolveHandle = vm.newFunction("getResolve", (keyHandle) => {
        const key: unknown = vm.dump(keyHandle)

        if (typeof key !== "string") {
          return {
            error: vm.newString("Expected key to be a string"),
          }
        }

        const result = pipe(
          getEnv(key, currentEnvs),
          E.fromOption(() => "INVALID_KEY" as const),

          E.map(({ value }) =>
            pipe(
              parseTemplateStringE(value, [...envs.selected, ...envs.global]),
              // If the recursive resolution failed, return the unresolved value
              E.getOrElse(() => value)
            )
          ),

          // Create a new VM String
          // NOTE: Do not shorten this to map(vm.newString) apparently it breaks it
          E.map((x) => vm.newString(x)),

          E.getOrElse(() => vm.undefined)
        )

        return {
          value: result,
        }
      })

      const envSetHandle = vm.newFunction("set", (keyHandle, valueHandle) => {
        const key: unknown = vm.dump(keyHandle)
        const value: unknown = vm.dump(valueHandle)

        if (typeof key !== "string") {
          return {
            error: vm.newString("Expected key to be a string"),
          }
        }

        if (typeof value !== "string") {
          return {
            error: vm.newString("Expected value to be a string"),
          }
        }

        currentEnvs = setEnv(key, value, currentEnvs)

        return {
          value: vm.undefined,
        }
      })

      const envResolveHandle = vm.newFunction("resolve", (valueHandle) => {
        const value: unknown = vm.dump(valueHandle)

        if (typeof value !== "string") {
          return {
            error: vm.newString("Expected value to be a string"),
          }
        }

        const result = pipe(
          parseTemplateStringE(value, [
            ...currentEnvs.selected,
            ...currentEnvs.global,
          ]),
          E.getOrElse(() => value)
        )

        return {
          value: vm.newString(result),
        }
      })

      const generateHDHandle = vm.newFunction("generateHD", () => {
        const result = crypto.createHash('sha256').update(requestBody).digest('base64')

        return {
          value: vm.newString(result),
        }
      })

      const generateJWTHandle = vm.newFunction("generateJWT", (headerHandle, additionalClaimsHandle, privateKeyHandle) => {
        const header: unknown = vm.dump(headerHandle)
        const additionalClaims: unknown = vm.dump(additionalClaimsHandle)
        const privateKey: unknown = vm.dump(privateKeyHandle)
        const fixedClaims =  {
          "iat": KJUR.jws.IntDate.get("now") - 5,
          "nbf": KJUR.jws.IntDate.get("now") - 5,
          "exp": KJUR.jws.IntDate.get("now + 1hour")
        }
        
        const claimSet = Object.assign(additionalClaims, fixedClaims)

        const result = KJUR.jws.JWS.sign("RS256", header, claimSet, privateKey)

        return {
          value: vm.newString(result),
        }
      })

      vm.setProp(envHandle, "resolve", envResolveHandle)
      envResolveHandle.dispose()

      vm.setProp(envHandle, "set", envSetHandle)
      envSetHandle.dispose()

      vm.setProp(envHandle, "getResolve", envGetResolveHandle)
      envGetResolveHandle.dispose()

      vm.setProp(envHandle, "get", envGetHandle)
      envGetHandle.dispose()

      vm.setProp(pwHandle, "env", envHandle)
      envHandle.dispose()

      vm.setProp(phHandle, "generateJWT", generateJWTHandle)
      generateJWTHandle.dispose()

      vm.setProp(phHandle, "generateHD", generateHDHandle)
      generateHDHandle.dispose()

      vm.setProp(vm.global, "ph", phHandle)
      phHandle.dispose()

      vm.setProp(vm.global, "pw", pwHandle)
      pwHandle.dispose()

      const evalRes = vm.evalCode(preRequestScript)

      if (evalRes.error) {
        const errorData = vm.dump(evalRes.error)
        evalRes.error.dispose()

        return TE.left(errorData)
      }

      vm.dispose()

      return TE.right(currentEnvs)
    })
  )
