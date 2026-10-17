#!/usr/bin/env bash
# Builds and signs the 叮咚 APK on this machine, then hands only the signed APK to the
# "Publish Android APK" workflow, which verifies it and adds it to the v<version> release.
# The signing key stays in .android-signing/ (git-ignored) and is never pushed.
#
# Usage (Git Bash, from anywhere):  android/publish-apk.sh
# Bump dingdongVersionName and dingdongVersionCode in android/gradle.properties first.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
signing="$root/.android-signing"
branch=android-apk-upload

export JAVA_HOME="${JAVA_HOME:-C:/Program Files/Java/jdk-21.0.10}"
export ANDROID_HOME="${ANDROID_HOME:-D:/Android/Sdk}"

[[ -f "$signing/dingdong-android.jks" && -f "$signing/signing.txt" ]] \
  || { echo "Missing $signing/dingdong-android.jks or signing.txt." >&2; exit 1; }
[[ -z "$(git -C "$root" status --porcelain)" ]] \
  || { echo 'Commit or stash your changes first, so the tag matches what you built.' >&2; exit 1; }

version=$(sed -n 's/^dingdongVersionName=//p' "$root/android/gradle.properties" | tr -d '\r')
tag="v$version"
echo "Building $tag"

password=$(sed -n 's/^password=//p' "$signing/signing.txt" | tr -d '\r')
(
  cd "$root/android"
  DINGDONG_ANDROID_KEYSTORE="$signing/dingdong-android.jks" \
  DINGDONG_ANDROID_KEY_ALIAS=dingdong \
  DINGDONG_ANDROID_STORE_PASSWORD="$password" \
  DINGDONG_ANDROID_KEY_PASSWORD="$password" \
    ./gradlew.bat --no-daemon --console=plain assembleRelease
)
unset password
apk="$root/android/app/build/outputs/apk/release/app-release.apk"
[[ -f "$apk" ]] || { echo "Gradle did not produce $apk." >&2; exit 1; }

if ! git -C "$root" rev-parse -q --verify "refs/tags/$tag" > /dev/null; then
  git -C "$root" tag -a "$tag" -m "$tag"
fi
git -C "$root" push origin "refs/tags/$tag"

work=$(mktemp -d)
trap 'git -C "$root" worktree remove --force "$work" 2> /dev/null || true; git -C "$root" branch -D "$branch" > /dev/null 2>&1 || true' EXIT
git -C "$root" worktree add --orphan -b "$branch" "$work" > /dev/null
mkdir -p "$work/.github/workflows"
cp "$root/.github/workflows/android-publish.yml" "$work/.github/workflows/"
cp "$apk" "$work/DingDong-Android.apk"
printf '%s\n' "$tag" > "$work/TAG"
git -C "$work" add -A
git -C "$work" commit -q -m "Publish $tag"
git -C "$work" push --force origin "$branch"

echo "Pushed $branch. The Publish Android APK workflow will publish $tag:"
echo "  https://github.com/Dan-k391/dingdong/actions/workflows/android-publish.yml"
echo "Once it has finished, delete the upload branch:  git push origin --delete $branch"
