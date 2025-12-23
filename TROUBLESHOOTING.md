# Troubleshooting Dev Server

## Server Says "Ready" But Can't Connect

If `npm run dev` shows it started but you cannot connect:

### 1. Check if Server is Actually Running

```bash
# Check if port 3000 is listening
lsof -i :3000

# Or
netstat -an | grep 3000
```

### 2. Test Connectivity

```bash
# Simple test
curl http://localhost:3000/api/health
```

### 3. Common Issues

#### Issue: TypeScript Errors
**Symptom**: Type errors prevent compilation
**Fix**: Fix type errors or use `// @ts-ignore` temporarily

#### Issue: Port Already in Use
**Symptom**: "Address already in use" error
**Fix**:
```bash
# Kill process on port 3000
lsof -ti:3000 | xargs kill -9

# Or use a different port
PORT=3001 npm run dev
```

#### Issue: Build Errors
**Symptom**: Server starts but crashes on first request
**Fix**: Check console for runtime errors

### 4. Debug Steps

1. **Check for errors in terminal**:
   - Look for red error messages
   - Check for stack traces

2. **Verify routes are correct**:
   ```bash
   curl http://localhost:3000/api/health
   curl http://localhost:3000/dev
   curl http://localhost:3000/api/system/0?action=snapshot
   ```

3. **Check browser console**:
   - Open browser dev tools
   - Look for CORS errors
   - Check network tab

4. **Restart server**:
   ```bash
   # Stop server (Ctrl+C)
   # Restart
   npm run dev
   ```

### 5. Verify Code Compiles

```bash
npm run type-check
```

## Still Not Working?

1. Check terminal output for crashes
2. Verify the server port with `PORT=3000`
3. Check Node.js version: `node --version` (should be 18+)
